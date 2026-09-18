/**
 * Per-request context on AsyncLocalStorage, so tenant and actor reach the
 * repository layer and every log line without being threaded through each
 * function signature — and so a repository cannot be handed the wrong tenant.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../modules/auth/permissions.js';

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly ip: string | undefined;

  tenantId?: string;
  userId?: string;
  role?: Role;
  /** null means every outlet in the tenant. */
  outletIds?: readonly string[] | null;
  /** Row id in `devices`, from the access token. */
  deviceId?: string;
}

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
  outletIds: readonly string[] | null;
  deviceId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function enrichContext(
  fields: Partial<Omit<RequestContext, 'requestId' | 'startedAt'>>,
): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

// Throws a plain Error, not an AppError: reaching this without auth is a
// routing bug and should surface as a 500, not as a client-facing 401.
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (!tenantId) throw new Error('Tenant-scoped operation reached without authentication.');
  return tenantId;
}

export function requireAuthContext(): AuthContext {
  const store = storage.getStore();
  if (
    !store?.tenantId ||
    !store.userId ||
    !store.role ||
    !store.deviceId ||
    store.outletIds === undefined
  ) {
    throw new Error('Authenticated operation reached without the access-token middleware.');
  }
  return {
    tenantId: store.tenantId,
    userId: store.userId,
    role: store.role,
    outletIds: store.outletIds,
    deviceId: store.deviceId,
  };
}

export function contextForLogging(): Record<string, string> {
  const store = storage.getStore();
  if (!store) return {};
  const fields: Record<string, string> = { requestId: store.requestId };
  if (store.tenantId) fields['tenantId'] = store.tenantId;
  if (store.userId) fields['userId'] = store.userId;
  if (store.deviceId) fields['deviceId'] = store.deviceId;
  return fields;
}
