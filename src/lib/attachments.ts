/**
 * Files attached to a record (an expense, a bill, an order…).
 *
 * One shape, one check, used by every document that takes attachments, so the
 * rules cannot drift apart between a sale and a purchase.
 *
 * A record stores *references*: the object key in the private bucket plus
 * enough to show it (name, type, size). Never a URL — those expire — and never
 * the bytes.
 */
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { assertKeyHasKind, remove, verifyUploadedObject, type ObjectKind } from './storage.js';
import { nonEmpty, objectKey } from './validators.js';

/** Most files one record may carry. Keeps a bill's payload and its page sane. */
export const MAX_ATTACHMENTS = 10;

export const attachmentSchema = z.object({
  objectKey,
  /** `image` is shown as a picture; `document` is opened in another app. */
  kind: z.enum(['image', 'document']),
  /** What the person called it, e.g. `delivery-note.pdf`. */
  name: nonEmpty.max(200).optional(),
  /**
   * The file's real type. Needed only when the app uploaded it compressed
   * (`encoding: 'gzip'`), because the stored object is then `application/gzip`.
   */
  contentType: z.string().max(100).optional(),
  /** Bytes as stored (after compression). */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Set when the stored object is gzip-compressed and must be unzipped to open. */
  encoding: z.literal('gzip').optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const attachmentsField = z.array(attachmentSchema).max(MAX_ATTACHMENTS);

/**
 * The kinds of object a record's attachment may point at. `order_attachment`
 * and `receipt` are the older kinds, still honoured so existing records and
 * older app versions keep working.
 */
const ATTACHMENT_OBJECT_KINDS: readonly ObjectKind[] = [
  'attachment_image',
  'attachment_file',
  'order_attachment',
  'receipt',
];

/**
 * Proves every key is this business's and was uploaded for attaching, and that
 * a picture points at a picture. Throws a 403 for another business's key and a
 * 422 for anything else — before the record is written.
 */
export function assertAttachments(attachments: readonly Attachment[] | undefined): void {
  const seen = new Set<string>();
  for (const attachment of attachments ?? []) {
    assertKeyHasKind(attachment.objectKey, ATTACHMENT_OBJECT_KINDS);
    if (seen.has(attachment.objectKey)) {
      throw new ValidationError('The same file is attached twice.', {
        details: { objectKey: attachment.objectKey },
      });
    }
    seen.add(attachment.objectKey);

    const objectKind = attachment.objectKey.split('/')[1];
    if (attachment.kind === 'image' && objectKind === 'attachment_file') {
      throw new ValidationError('A document cannot be attached as a picture.', {
        details: { objectKey: attachment.objectKey },
      });
    }
    if (attachment.kind === 'document' && objectKind === 'attachment_image') {
      throw new ValidationError('A picture cannot be attached as a document.', {
        details: { objectKey: attachment.objectKey },
      });
    }
  }
}

/**
 * The full check, run before a record is written: the rules above, then a look
 * at each real file in storage (exists, not empty, within its size limit, and
 * really the type it claims). A file that fails is deleted and the request is
 * refused, so a bad file is never stored behind a record.
 */
export async function checkAttachments(
  attachments: readonly Attachment[] | undefined,
): Promise<void> {
  assertAttachments(attachments);
  await Promise.all(
    (attachments ?? []).map((a) => verifyUploadedObject(a.objectKey, ATTACHMENT_OBJECT_KINDS)),
  );
}

/**
 * Deletes the files an edit took off a record. Best effort and after the
 * change has committed: a failed delete leaves an unreferenced file, never a
 * record pointing at nothing.
 */
export async function removeDroppedAttachments(
  before: unknown,
  after: readonly Attachment[] | undefined,
): Promise<void> {
  if (after === undefined || !Array.isArray(before)) return;
  const kept = new Set(after.map((a) => a.objectKey));
  const dropped = (before as { objectKey?: unknown }[])
    .map((a) => a.objectKey)
    .filter((key): key is string => typeof key === 'string' && !kept.has(key));
  await Promise.all(dropped.map((key) => remove(key)));
}
