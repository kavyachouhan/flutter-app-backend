/**
 * Typed access to a supertest response body.
 *
 * `res.body` is `any`, so `res.body.data.id` type-checks even when the server
 * returned an error envelope — the assertion then compares `undefined` to
 * `undefined` and the test passes while the endpoint is broken. These helpers
 * assert the envelope actually exists before handing back a typed value.
 */
import type { Response } from 'supertest';

interface SuccessEnvelope<T> {
  data: T;
  nextCursor?: string | null;
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

/** The `{ data }` payload, or a failure naming what came back instead. */
export function data<T>(res: Response): T {
  const body: unknown = res.body;
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error(
      `Expected a { data } envelope, got ${res.status}: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  return (body as SuccessEnvelope<T>).data;
}

/** The `{ data }` payload of a list response, asserted to be an array. */
export function rows<T>(res: Response): T[] {
  const value = data<T[]>(res);
  if (!Array.isArray(value)) {
    throw new Error(`Expected a list, got ${JSON.stringify(value).slice(0, 200)}`);
  }
  return value;
}

/**
 * Asserts a status and, when it does not match, fails with the server's error
 * envelope rather than just the number. A bare "expected 201, got 422" costs a
 * round trip to diagnose, because 422 covers a dozen distinct domain codes.
 */
export async function expectStatus(
  pending: PromiseLike<Response>,
  status: number,
): Promise<Response> {
  const res = await pending;
  if (res.status !== status) {
    throw new Error(
      `Expected ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`,
    );
  }
  return res;
}

/** The `{ error }` payload, for asserting on codes rather than status alone. */
export function error(res: Response): ErrorEnvelope['error'] {
  const body: unknown = res.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error(
      `Expected an { error } envelope, got ${res.status}: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  return (body as ErrorEnvelope).error;
}
