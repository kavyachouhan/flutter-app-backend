/**
 * Builds a tenant the way a real client does — dev-login for an identity
 * token, then POST /onboarding/tenants — rather than inserting rows. Tests
 * then exercise the same path the Flutter app takes, and a break in onboarding
 * surfaces here instead of hiding behind a fixture that bypassed it.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../../src/app.js';
import { data } from './body.js';

interface DevLoginResult {
  identity: { identityToken: string; userId: string };
}

interface OnboardResult {
  tenant: { id: string; name: string };
  session: { accessToken: string; userId: string; deviceId: string };
}

const app = createApp();

/** Unique per fixture so users and devices never collide across test files. */
function uniquePhone(): string {
  return `9${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
}

/**
 * GSTIN is unique across every tenant (tenants_gstin_uq), not just within one,
 * so a shared literal makes the second GST-registered tenant in a state fail
 * onboarding with a 409. The first two characters are the state code by law.
 */
function uniqueGstin(stateCode: string): string {
  const letters = Array.from(
    { length: 5 },
    () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)],
  ).join('');
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return `${stateCode}${letters}${digits}A1Z5`;
}

export interface TenantFixture {
  tenantId: string;
  outletId: string;
  counterId: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  phone: string;
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  patch: (path: string) => request.Test;
  del: (path: string) => request.Test;
}

export interface TenantOptions {
  name?: string;
  stateCode?: string;
  isGstRegistered?: boolean;
  gstin?: string | null;
}

export async function createTenant(options: TenantOptions = {}): Promise<TenantFixture> {
  const phone = uniquePhone();
  const stateCode = options.stateCode ?? '27';
  const isGstRegistered = options.isGstRegistered ?? true;

  const login = await request(app)
    .post('/v1/auth/dev-login')
    .send({ phone, name: 'Integration Test User' })
    .expect(200);
  const identityToken = data<DevLoginResult>(login).identity.identityToken;

  const tenantId = randomUUID();
  const outletId = randomUUID();
  const counterId = randomUUID();

  const created = await request(app)
    .post('/v1/onboarding/tenants')
    .set('Authorization', `Bearer ${identityToken}`)
    .send({
      id: tenantId,
      name: options.name ?? 'Integration Test Shop',
      isGstRegistered,
      gstin: isGstRegistered ? (options.gstin ?? uniqueGstin(stateCode)) : null,
      stateCode,
      outlet: { id: outletId, name: 'Main', code: 'MAIN' },
      counter: { id: counterId, name: 'Counter 1', code: 'C1' },
      device: { deviceKey: randomUUID(), platform: 'android', label: 'test-device' },
    })
    .expect(201);

  const { session } = data<OnboardResult>(created);
  const auth = `Bearer ${session.accessToken}`;

  return {
    tenantId,
    outletId,
    counterId,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    phone,
    get: (path) => request(app).get(path).set('Authorization', auth),
    post: (path) => request(app).post(path).set('Authorization', auth),
    patch: (path) => request(app).patch(path).set('Authorization', auth),
    del: (path) => request(app).delete(path).set('Authorization', auth),
  };
}

export { app };
