/**
 * Documents carry client-generated ids so an offline device can retry an
 * upload any number of times and the server still stores one row. v7 is
 * preferred (time-ordered, so B-tree inserts append instead of scattering);
 * v4 is accepted because older app builds send it.
 */
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';
import { z } from 'zod';

export type Uuid = string;

export function newId(): Uuid {
  return uuidv7();
}

export function isClientDocumentId(value: unknown): value is Uuid {
  if (typeof value !== 'string' || !uuidValidate(value)) return false;
  const version = uuidVersion(value);
  return version === 7 || version === 4;
}

export const clientId = z.string().refine(isClientDocumentId, 'must be a UUID v4 or v7');
export const uuidParam = z.string().uuid();
