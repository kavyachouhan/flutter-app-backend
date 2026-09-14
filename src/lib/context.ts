/**
 * Per-request context carried on an AsyncLocalStorage.
 *
 * Without this, `requestId`/`tenantId`/`userId` have to be threaded as
 * parameters through every service and repository purely so a log line deep
 * in the stack can be correlated. ALS gives us that correlation for free and
 * keeps the domain layer's signatures about the domain.
 *
 * It is read-only downstream: the request middleware establishes the store,
 * and the auth middleware enriches it once the token is verified.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Correlation id echoed to the client as `x-request-id`. */
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  /** `performance.now()` at request start, for duration measurement. */
  readonly startedAt: number;

  /** Populated by the auth middleware; absent on public routes. */
  tenantId?: string;
  userId?: string;
  role?: string;
  outletId?: string;
  /** Device that sent the request, from the `x-device-id` header. */
  deviceId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` visible to everything it awaits. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The active context, or `undefined` outside a request — background jobs and
 * startup code legitimately have none, so callers must handle that rather
 * than this throwing.
 */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * The tenant for the current request, or throws.
 *
 * Repositories call this rather than accepting a `tenantId` parameter, which
 * removes an entire class of bug: you cannot forget to pass it, and you cannot
 * pass the wrong one. A throw here means a tenant-scoped query was reached on
 * an unauthenticated path — a routing bug, not a user error.
 */
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (!tenantId) {
    throw new Error(
      'No tenant in the request context. A tenant-scoped operation was reached without the ' +
        'auth middleware having run — check the route wiring.',
    );
  }
  return tenantId;
}

export function requireUserId(): string {
  const userId = storage.getStore()?.userId;
  if (!userId) {
    throw new Error(
      'No user in the request context. An operation requiring an actor was reached without the ' +
        'auth middleware having run — check the route wiring.',
    );
  }
  return userId;
}

/** Merges authenticated identity into the active context. */
export function enrichContext(fields: Partial<Omit<RequestContext, 'requestId'>>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, fields);
}

/** The subset of context worth attaching to every log line. */
export function contextForLogging(): Record<string, string> {
  const store = storage.getStore();
  if (!store) return {};

  const fields: Record<string, string> = { requestId: store.requestId };
  if (store.tenantId) fields['tenantId'] = store.tenantId;
  if (store.userId) fields['userId'] = store.userId;
  if (store.outletId) fields['outletId'] = store.outletId;
  if (store.deviceId) fields['deviceId'] = store.deviceId;
  return fields;
}
