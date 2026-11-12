/** Contracts shared by every versioned portal-payload mapper. */

export type MapperVerification =
  /** Built from the official request schema for this exact payload. */
  | 'schema_verified'
  /**
   * Built from official schemas that describe a *different* call (e.g. the GSTR-1 "Get" response
   * schemas, for an upload payload no official request schema was supplied for). The shape is a
   * best reading, not a confirmed contract: exports are labelled draft.
   */
  | 'derived_from_related_schema';

export interface MapperIssue {
  readonly severity: 'error' | 'warning';
  /** Stable machine code, e.g. `section_unsupported`, `schema_invalid`. */
  readonly code: string;
  readonly message: string;
  /** JSON-pointer-like location in the payload, or the neutral section name. */
  readonly path?: string;
}

export interface MapperMeta {
  /** e.g. `gstr3b-v2026.11`: form + the month the schema snapshot was captured. */
  readonly id: string;
  readonly form: 'gstr1' | 'gstr3b';
  readonly verification: MapperVerification;
}

export interface MapResult<P> {
  readonly mapperId: string;
  readonly payload: P;
  readonly issues: readonly MapperIssue[];
}

export interface ReturnMapper<M, P> {
  readonly meta: MapperMeta;
  map(model: M): MapResult<P>;
}
