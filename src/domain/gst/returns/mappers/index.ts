/**
 * Mapper registry: registry.json id -> code. Adding a format = one new file + one line here.
 */
import { gstr1Mapper } from './gstr1-v2026.11.js';
import { gstr3bMapper } from './gstr3b-v2026.11.js';
import type { ReturnMapper } from './types.js';

export const MAPPERS: Readonly<Record<string, ReturnMapper<never, unknown>>> = {
  [gstr1Mapper.meta.id]: gstr1Mapper,
  [gstr3bMapper.meta.id]: gstr3bMapper,
};

export { gstr1Mapper, gstr3bMapper };
