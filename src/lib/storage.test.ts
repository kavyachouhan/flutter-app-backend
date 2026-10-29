import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAttachments, attachmentsField, MAX_ATTACHMENTS } from './attachments.js';
import { runWithContext } from './context.js';
import { ForbiddenError, ValidationError } from './errors.js';
import {
  assertKeyBelongsToTenant,
  assertKeyHasKind,
  policyFor,
  signUpload,
} from './storage.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MB = 1024 * 1024;

const asTenant = <T>(fn: () => T): T =>
  runWithContext({ requestId: 'test', startedAt: 0, ip: undefined, tenantId: TENANT }, fn);

const key = (kind: string, ext = 'jpg', tenant = TENANT): string =>
  `${tenant}/${kind}/33333333-3333-4333-8333-333333333333.${ext}`;

afterEach(() => vi.unstubAllGlobals());

/** Storage answers every signing call with a canned upload URL. */
function stubStorage(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ url: '/object/upload/sign/b/x?token=t' }), { status: 200 }),
      ),
    ),
  );
}

describe('upload policies', () => {
  it('holds item photos and image attachments to 5 MB, raster only', () => {
    for (const kind of ['item_image', 'attachment_image'] as const) {
      expect(policyFor(kind).maxBytes).toBe(5 * MB);
      expect(Object.keys(policyFor(kind).types).sort()).toEqual(
        ['image/jpeg', 'image/png', 'image/webp'].sort(),
      );
    }
  });

  it('holds attached documents to 10 MB and never allows scripts or SVG', () => {
    const policy = policyFor('attachment_file');
    expect(policy.maxBytes).toBe(10 * MB);
    expect(policy.types['application/pdf']).toBe('pdf');
    expect(policy.types['application/gzip']).toBe('gz');
    for (const bad of [
      'image/svg+xml',
      'text/html',
      'application/javascript',
      'application/x-msdownload',
    ]) {
      expect(policy.types[bad], bad).toBeUndefined();
    }
  });

  it('signs a 4 MB item photo and refuses 6 MB', async () => {
    stubStorage();
    const ok = await asTenant(() => signUpload('item_image', 'image/jpeg', 4 * MB));
    expect(ok.objectKey).toMatch(new RegExp(`^${TENANT}/item_image/[0-9a-f-]+\\.jpg$`));
    await expect(asTenant(() => signUpload('item_image', 'image/jpeg', 6 * MB))).rejects.toThrow(
      ValidationError,
    );
  });

  it('signs a 9 MB document and refuses 11 MB', async () => {
    stubStorage();
    await expect(
      asTenant(() => signUpload('attachment_file', 'application/pdf', 9 * MB)),
    ).resolves.toBeDefined();
    await expect(
      asTenant(() => signUpload('attachment_file', 'application/pdf', 11 * MB)),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a type the kind does not allow', async () => {
    stubStorage();
    await expect(asTenant(() => signUpload('item_image', 'application/pdf', 1000))).rejects.toThrow(
      ValidationError,
    );
    await expect(
      asTenant(() => signUpload('attachment_file', 'image/svg+xml', 1000)),
    ).rejects.toThrow(ValidationError);
  });

  it('puts every file under its own business folder', async () => {
    stubStorage();
    const a = await asTenant(() => signUpload('attachment_file', 'application/pdf', 1000));
    expect(a.objectKey.startsWith(`${TENANT}/`)).toBe(true);
  });
});

describe('object keys', () => {
  it("accepts this business's key and refuses another's", () => {
    expect(() => asTenant(() => assertKeyBelongsToTenant(key('item_image')))).not.toThrow();
    expect(() => asTenant(() => assertKeyBelongsToTenant(key('item_image', 'jpg', OTHER)))).toThrow(
      ForbiddenError,
    );
  });

  it('refuses a path that climbs out of the folder', () => {
    for (const bad of [`${TENANT}/../${OTHER}/x.jpg`, `/${TENANT}/x.jpg`, `${TENANT}//x.jpg`]) {
      expect(() => asTenant(() => assertKeyBelongsToTenant(bad)), bad).toThrow(ForbiddenError);
    }
  });

  it('checks the kind as well as the owner', () => {
    expect(() => asTenant(() => assertKeyHasKind(key('item_image'), ['item_image']))).not.toThrow();
    expect(() => asTenant(() => assertKeyHasKind(key('logo', 'png'), ['item_image']))).toThrow(
      ValidationError,
    );
  });
});

describe('attachments on a record', () => {
  const image = (k: string) => ({ objectKey: k, kind: 'image' as const, name: 'bill.jpg' });
  const doc = (k: string) => ({ objectKey: k, kind: 'document' as const, name: 'po.pdf' });

  it('accepts pictures and documents uploaded for attaching', () => {
    expect(() =>
      asTenant(() =>
        assertAttachments([
          image(key('attachment_image')),
          doc(key('attachment_file', 'pdf').replace('3333', '4444')),
        ]),
      ),
    ).not.toThrow();
  });

  it('still accepts the older order_attachment and receipt kinds', () => {
    expect(() =>
      asTenant(() => assertAttachments([doc(key('order_attachment', 'pdf'))])),
    ).not.toThrow();
    expect(() => asTenant(() => assertAttachments([image(key('receipt'))]))).not.toThrow();
  });

  it("refuses another business's file", () => {
    expect(() =>
      asTenant(() => assertAttachments([image(key('attachment_image', 'jpg', OTHER))])),
    ).toThrow(ForbiddenError);
  });

  it('refuses a file that was uploaded for some other purpose', () => {
    expect(() => asTenant(() => assertAttachments([image(key('logo', 'png'))]))).toThrow(
      ValidationError,
    );
    expect(() => asTenant(() => assertAttachments([image(key('import', 'csv'))]))).toThrow(
      ValidationError,
    );
  });

  it('does not let a document pose as a picture, or the reverse', () => {
    expect(() => asTenant(() => assertAttachments([image(key('attachment_file', 'pdf'))]))).toThrow(
      ValidationError,
    );
    expect(() => asTenant(() => assertAttachments([doc(key('attachment_image'))]))).toThrow(
      ValidationError,
    );
  });

  it('refuses the same file twice', () => {
    const k = key('attachment_image');
    expect(() => asTenant(() => assertAttachments([image(k), image(k)]))).toThrow(ValidationError);
  });

  it('limits a record to ten files, and keeps the optional fields', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      objectKey: key('attachment_image').replace('3333', String(1000 + i)),
      kind: 'image',
    }));
    expect(attachmentsField.safeParse(many).success).toBe(false);
    expect(attachmentsField.safeParse(many.slice(0, MAX_ATTACHMENTS)).success).toBe(true);

    const gz = attachmentsField.parse([
      {
        objectKey: key('attachment_file', 'gz'),
        kind: 'document',
        name: 'stock.csv',
        contentType: 'text/csv',
        sizeBytes: 4096,
        encoding: 'gzip',
      },
    ]);
    expect(gz[0]?.encoding).toBe('gzip');
    expect(gz[0]?.contentType).toBe('text/csv');
  });
});
