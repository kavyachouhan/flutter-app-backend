/**
 * Supabase Storage, reached over its REST API.
 *
 * The shape of this module follows from one decision: **no file byte transits
 * this API**. The server holds the service-role key and does nothing with it
 * but mint short-lived signed URLs; the client PUTs straight to Supabase and
 * GETs straight from it. The alternative — proxying multipart through Express
 * — costs a request's worth of memory per megabyte and gives a shop on a
 * flaky 4G connection no way to resume.
 *
 * That choice moves the security boundary. A signed URL is a bearer
 * credential on the bucket, so three things hold it in place:
 *
 *   1. Every key is prefixed with the tenant id, and `assertKeyBelongsToTenant`
 *      re-checks that prefix on the way back in. The key is the only thing a
 *      client hands us, so it is the only thing we can verify.
 *   2. Content type and size are validated at signing time, because that is
 *      the last moment the server sees the request at all.
 *   3. TTLs are short and signing is rate limited separately from the rest of
 *      the API.
 *
 * `fetch` rather than @supabase/supabase-js: the SDK is a large dependency
 * that would also tempt someone into using it for Postgres, which would walk
 * straight around the RLS discipline in src/db/tx.ts.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { requireTenantId } from './context.js';
import { DependencyError, ForbiddenError, ValidationError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('storage');

export const OBJECT_KINDS = [
  'logo',
  'signature',
  'receipt',
  'order_attachment',
  // A photo of an item, shown in the items list and on the bill.
  'item_image',
  // What a person attaches to a record (an expense, a bill, an order): a photo
  // or scan, and separately a document. Two kinds because the limits differ.
  'attachment_image',
  'attachment_file',
  'import',
  'export',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

interface KindPolicy {
  /** Allowed content types, mapped to the extension the key will carry. */
  readonly types: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  /**
   * False for objects only the server writes. An export is generated from
   * tenant data; letting a client upload one would let it put arbitrary bytes
   * behind a URL the UI presents as the shop's own report.
   */
  readonly clientSignable: boolean;
}

const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

const SPREADSHEET_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
} as const;

/**
 * Documents a person may attach. No executables, scripts, HTML or SVG: a file
 * stored here is opened on someone else's device.
 *
 * `application/gzip` is how the app uploads a document it has compressed
 * (lossless; it only does so when that makes the file smaller). The record
 * keeps the original name and type, so the viewer can restore it.
 */
const FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/gzip': 'gz',
} as const;

const MB = 1024 * 1024;

const POLICIES: Readonly<Record<ObjectKind, KindPolicy>> = {
  // Printed on every bill, so small and raster-only: an SVG on a document is
  // a script-execution surface in any viewer that renders it.
  logo: { types: IMAGE_TYPES, maxBytes: 2 * MB, clientSignable: true },
  signature: { types: IMAGE_TYPES, maxBytes: 1 * MB, clientSignable: true },
  receipt: {
    types: { ...IMAGE_TYPES, 'application/pdf': 'pdf' },
    maxBytes: 5 * MB,
    clientSignable: true,
  },
  // A photo or PDF attached to a sales order. Same policy as a receipt.
  order_attachment: {
    types: { ...IMAGE_TYPES, 'application/pdf': 'pdf' },
    maxBytes: 5 * MB,
    clientSignable: true,
  },
  // Raster only, like a logo. The limit is generous because it bounds what the
  // app may *send*: the app shrinks every photo to a few hundred KB first.
  item_image: { types: IMAGE_TYPES, maxBytes: 5 * MB, clientSignable: true },
  attachment_image: { types: IMAGE_TYPES, maxBytes: 5 * MB, clientSignable: true },
  attachment_file: { types: FILE_TYPES, maxBytes: 10 * MB, clientSignable: true },
  // JSON as well as spreadsheets, because a GSTR-2B statement is downloaded
  // from the GST portal as JSON. It is parsed, never served back, so the
  // content type is only ever used to pick an extension and bound the size.
  import: {
    types: { ...SPREADSHEET_TYPES, 'application/json': 'json' },
    maxBytes: 10 * MB,
    clientSignable: true,
  },
  // JSON as well, for a GST return in the portal's own upload format. Still
  // server-written only: an export is generated from tenant data, and letting
  // a client upload one would put arbitrary bytes behind a URL the UI presents
  // as the shop's own return.
  export: {
    types: { ...SPREADSHEET_TYPES, 'application/json': 'json' },
    maxBytes: 25 * MB,
    clientSignable: false,
  },
};

export interface SignedUpload {
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface SignedDownload {
  readonly url: string;
  readonly expiresAt: string;
}

const storageBase = (): string => `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`;

function authHeaders(): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

/**
 * Every call goes through here so that a storage outage is a 503 naming the
 * dependency rather than an unhandled rejection, and so no response body
 * containing a signed token is ever logged.
 */
async function call(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${storageBase()}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(env.STORAGE_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    log.error({ path }, 'Storage request failed');
    throw new DependencyError('object storage', { cause });
  }

  if (!response.ok) {
    // Status and path only: the body can echo the signing token back.
    log.error({ path, status: response.status }, 'Storage request rejected');
    throw new DependencyError('object storage', {
      details: { status: response.status },
    });
  }
  return response;
}

function expiryFrom(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** `{tenantId}/{kind}/{uuid}.{ext}` — the tenant prefix is what makes a key checkable. */
function buildObjectKey(tenantId: string, kind: ObjectKind, extension: string): string {
  return `${tenantId}/${kind}/${randomUUID()}.${extension}`;
}

/**
 * The one check that stands between a client and another tenant's files.
 *
 * A signed URL is minted for whatever key we are given, so a key arriving
 * from a request must be proven to sit under the caller's own prefix before
 * it is used for anything at all.
 */
export function assertKeyBelongsToTenant(objectKey: string): void {
  const tenantId = requireTenantId();
  // Reject traversal before the prefix test, so `tenant/../other/x` cannot
  // satisfy the prefix and then resolve elsewhere inside the bucket.
  if (objectKey.includes('..') || objectKey.startsWith('/') || objectKey.includes('//')) {
    throw new ForbiddenError('That object key is not valid.');
  }
  if (!objectKey.startsWith(`${tenantId}/`)) {
    throw new ForbiddenError('That object does not belong to this business.');
  }
}

/**
 * Proves a key from a request body is this business's *and* was signed for one
 * of [kinds]. The second check stops a record pointing at the wrong sort of
 * file: a logo key stored as an expense receipt would be a 2 MB image that was
 * never held to the receipt policy.
 */
export function assertKeyHasKind(objectKey: string, kinds: readonly ObjectKind[]): void {
  assertKeyBelongsToTenant(objectKey);
  const kind = objectKey.split('/')[1];
  if (!kinds.some((k) => k === kind)) {
    throw new ValidationError('That file was not uploaded for this purpose.', {
      details: { allowed: kinds },
    });
  }
}

export function policyFor(kind: ObjectKind): KindPolicy {
  return POLICIES[kind];
}

/**
 * A short-lived URL the client PUTs bytes to.
 *
 * `sizeBytes` is what the client *claims* it will upload. It is checked here
 * because it is cheap and catches the honest case, but it is not a guarantee:
 * the real ceiling is the bucket's own file size limit, which must be
 * configured in Supabase to match STORAGE_MAX_UPLOAD_BYTES. A client that
 * lies about the size gets stopped by the bucket, not by us.
 */
export async function signUpload(
  kind: ObjectKind,
  contentType: string,
  sizeBytes: number,
): Promise<SignedUpload> {
  const tenantId = requireTenantId();
  const policy = POLICIES[kind];

  if (!policy.clientSignable) {
    throw new ForbiddenError(`${kind} objects are written by the server, not uploaded.`);
  }
  const extension = policy.types[contentType];
  if (!extension) {
    throw new ValidationError(`A ${kind} cannot be a ${contentType}.`, {
      details: { allowed: Object.keys(policy.types) },
    });
  }
  const limit = Math.min(policy.maxBytes, env.STORAGE_MAX_UPLOAD_BYTES);
  if (sizeBytes > limit) {
    throw new ValidationError(`That file is larger than the ${limit} byte limit for a ${kind}.`, {
      details: { sizeBytes, maxBytes: limit },
    });
  }

  const objectKey = buildObjectKey(tenantId, kind, extension);
  const response = await call(
    `/object/upload/sign/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: env.STORAGE_UPLOAD_URL_TTL_SECONDS }),
    },
  );

  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new DependencyError('object storage');

  return {
    objectKey,
    uploadUrl: `${storageBase()}${body.url.startsWith('/') ? '' : '/'}${body.url}`,
    expiresAt: expiryFrom(env.STORAGE_UPLOAD_URL_TTL_SECONDS),
  };
}

/** A short-lived read URL. The caller must have checked the key's ownership. */
export async function signDownload(
  objectKey: string,
  downloadFilename?: string,
): Promise<SignedDownload> {
  assertKeyBelongsToTenant(objectKey);

  const response = await call(
    `/object/sign/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expiresIn: env.STORAGE_DOWNLOAD_URL_TTL_SECONDS,
        ...(downloadFilename ? { download: downloadFilename } : {}),
      }),
    },
  );

  const body = (await response.json()) as { signedURL?: string };
  if (!body.signedURL) throw new DependencyError('object storage');

  let url = `${storageBase()}${body.signedURL.startsWith('/') ? '' : '/'}${body.signedURL}`;
  if (downloadFilename && !url.includes('download=')) {
    url += `${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(downloadFilename)}`;
  }

  return {
    url,
    expiresAt: expiryFrom(env.STORAGE_DOWNLOAD_URL_TTL_SECONDS),
  };
}

/**
 * Reads an object into memory, for the server's own use.
 *
 * Bounded by STORAGE_MAX_UPLOAD_BYTES rather than streamed: the only caller
 * is the import ingest, which has to parse the whole workbook anyway, and a
 * spreadsheet small enough to upload from a phone is small enough to hold.
 */
export async function download(objectKey: string): Promise<Buffer> {
  assertKeyBelongsToTenant(objectKey);

  const response = await call(`/object/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`, {
    method: 'GET',
  });

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > env.STORAGE_MAX_UPLOAD_BYTES) {
    throw new ValidationError('That file is too large to process.', {
      details: { sizeBytes: declared, maxBytes: env.STORAGE_MAX_UPLOAD_BYTES },
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // Checked again after reading: content-length is a claim, not a fact.
  if (buffer.byteLength > env.STORAGE_MAX_UPLOAD_BYTES) {
    throw new ValidationError('That file is too large to process.', {
      details: { sizeBytes: buffer.byteLength, maxBytes: env.STORAGE_MAX_UPLOAD_BYTES },
    });
  }
  return buffer;
}

/** Uploads bytes the server generated. Used by the exporter. */
export async function upload(kind: ObjectKind, contentType: string, body: Buffer): Promise<string> {
  const tenantId = requireTenantId();
  const extension = POLICIES[kind].types[contentType];
  if (!extension) throw new ValidationError(`A ${kind} cannot be a ${contentType}.`);

  const objectKey = buildObjectKey(tenantId, kind, extension);
  await call(`/object/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  });
  return objectKey;
}

// ---------------------------------------------------------------------------
// Verifying what was actually uploaded
// ---------------------------------------------------------------------------

/** How much of the start of a file is read to check what it is. */
const HEAD_BYTES = 4096;

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0): boolean =>
  bytes.every((byte, i) => head[at + i] === byte);

const ascii = (head: Uint8Array, text: string, at = 0): boolean =>
  startsWith(
    head,
    [...text].map((c) => c.charCodeAt(0)),
    at,
  );

/**
 * What a program or script looks like at the start, whatever the file claims
 * to be: Windows/DOS executables, ELF, Mach-O, shell scripts, Java classes.
 */
function looksExecutable(head: Uint8Array): boolean {
  return (
    ascii(head, 'MZ') ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, [0xca, 0xfe, 0xba, 0xbe]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    ascii(head, '#!')
  );
}

/** Plain text that is really a web page or script: it would run where it is opened. */
function looksLikeMarkup(text: string): boolean {
  const start = text.slice(0, 1024).trimStart().toLowerCase();
  return (
    start.startsWith('<!doctype') ||
    start.startsWith('<html') ||
    start.startsWith('<?xml') ||
    start.startsWith('<svg') ||
    start.includes('<script')
  );
}

function decodesAsText(head: Uint8Array): string | null {
  if (head.includes(0)) return null; // NUL bytes: binary, not text
  // The read may end part-way through a multi-byte character; allow for it.
  for (let trim = 0; trim <= 3; trim += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - trim));
    } catch {
      // try again, one byte shorter
    }
  }
  return null;
}

/**
 * Returns what is wrong with a file, or null when its first bytes are what its
 * extension says. Pure, so it is tested without storage.
 *
 * Magic numbers prove the *kind* of file, not that every byte after them is
 * sound; the app also decodes pictures before sending them, and a file that
 * opens wrongly later is only ever shown to the person who attached it.
 */
export function checkFileSignature(extension: string, head: Uint8Array): string | null {
  if (head.length === 0) return 'The file is empty.';
  if (looksExecutable(head)) return 'That looks like a program, which cannot be uploaded.';

  switch (extension) {
    case 'jpg':
      return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'That is not a valid JPEG picture.';
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? null
        : 'That is not a valid PNG picture.';
    case 'webp':
      return ascii(head, 'RIFF') && ascii(head, 'WEBP', 8) ? null : 'That is not a valid WebP picture.';
    case 'pdf': {
      const limit = Math.min(head.length, 1024);
      for (let i = 0; i + 5 <= limit; i += 1) if (ascii(head, '%PDF-', i)) return null;
      return 'That is not a valid PDF.';
    }
    case 'zip':
    case 'docx':
    case 'xlsx':
      // PK\3\4 is a zip with at least one entry; PK\5\6 is an empty archive.
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ? null : 'That is not a valid document.';
    case 'gz':
      return startsWith(head, [0x1f, 0x8b]) ? null : 'That is not a valid compressed file.';
    case 'doc':
    case 'xls':
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
        ? null
        : 'That is not a valid document.';
    case 'csv':
    case 'txt': {
      const text = decodesAsText(head);
      if (text === null) return 'That is not a plain text file.';
      return looksLikeMarkup(text) ? 'That is a web page or script, not a text file.' : null;
    }
    default:
      return 'That file type is not accepted.';
  }
}

/**
 * Proves an uploaded object is sound before a record is allowed to point at it.
 *
 * Signing only validated what the client *said*. A signed URL lets the client
 * send anything, so this is where the real file is looked at: it must exist,
 * be non-empty, be within the kind's real size limit, and start with the bytes
 * its extension promises. A file that fails is deleted from the bucket and the
 * request is refused, so nothing bad is left behind or referenced.
 */
export async function verifyUploadedObject(
  objectKey: string,
  kinds: readonly ObjectKind[],
): Promise<void> {
  assertKeyHasKind(objectKey, kinds);
  const kind = objectKey.split('/')[1] as ObjectKind;
  const extension = objectKey.split('.').pop()?.toLowerCase() ?? '';

  let response: Response;
  try {
    response = await fetch(
      `${storageBase()}/object/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`,
      {
        method: 'GET',
        headers: { ...authHeaders(), range: `bytes=0-${HEAD_BYTES - 1}` },
        signal: AbortSignal.timeout(env.STORAGE_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    log.error({ objectKey }, 'Storage verification failed');
    throw new DependencyError('object storage', { cause });
  }

  if (response.status === 400 || response.status === 404) {
    throw new ValidationError('That file was not uploaded. Upload it again.', {
      details: { objectKey },
    });
  }
  if (!response.ok) throw new DependencyError('object storage', { details: { status: response.status } });

  // A ranged read answers `bytes 0-4095/TOTAL`; a short file answers whole.
  const range = response.headers.get('content-range');
  const head = new Uint8Array(await response.arrayBuffer());
  const total = range ? Number(range.split('/')[1]) : head.byteLength;

  const limit = Math.min(POLICIES[kind].maxBytes, env.STORAGE_MAX_UPLOAD_BYTES);
  const problem =
    total > limit
      ? `The file is larger than the ${limit} byte limit.`
      : checkFileSignature(extension, head.subarray(0, Math.min(head.byteLength, HEAD_BYTES)));

  if (problem) {
    log.warn({ objectKey, reason: problem }, 'Rejected an uploaded object');
    await remove(objectKey);
    throw new ValidationError(problem, { details: { objectKey } });
  }
}

/**
 * Best effort: an orphaned object costs storage, but a failed cleanup must
 * not fail the operation that triggered it (abandoning an import, replacing
 * a logo). The warning is what a sweeper would act on later.
 */
export async function remove(objectKey: string): Promise<void> {
  assertKeyBelongsToTenant(objectKey);
  try {
    await call(`/object/${env.SUPABASE_STORAGE_BUCKET}/${encodeKey(objectKey)}`, {
      method: 'DELETE',
    });
  } catch {
    log.warn({ objectKey }, 'Could not remove storage object; it is now orphaned');
  }
}

/** Each path segment is encoded; the slashes between them are structural. */
function encodeKey(objectKey: string): string {
  return objectKey.split('/').map(encodeURIComponent).join('/');
}
