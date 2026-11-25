import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../openapi/document.js';
import { erasedPhone } from './account.repository.js';
import { accountDeletionBody } from './account.schemas.js';
import { PURGE_WITHIN_DAYS } from './account.service.js';

describe('erasedPhone', () => {
  it('still satisfies the users.phone CHECK, so an erased row can be written', () => {
    for (let i = 0; i < 50; i += 1) expect(erasedPhone()).toMatch(/^[1-9][0-9]{7,14}$/);
  });

  it('can never be a real number: country code 999 is not assigned', () => {
    const phone = erasedPhone();
    expect(phone.startsWith('999')).toBe(true);
    expect(phone).toHaveLength(15);
  });

  it('is different each time, so two erased people are not linked', () => {
    expect(new Set(Array.from({ length: 20 }, erasedPhone)).size).toBe(20);
  });
});

describe('accountDeletionBody', () => {
  it('takes a scope and a one-time code', () => {
    expect(accountDeletionBody.parse({ scope: 'business', code: '123456' })).toEqual({
      scope: 'business',
      code: '123456',
    });
    expect(accountDeletionBody.parse({ scope: 'login', code: '0042' }).scope).toBe('login');
  });

  it('refuses a request without a code — a signed-in session alone cannot delete a business', () => {
    expect(() => accountDeletionBody.parse({ scope: 'business' })).toThrow();
    expect(() => accountDeletionBody.parse({ scope: 'business', code: 'abc' })).toThrow();
  });

  it('refuses any other scope', () => {
    expect(() => accountDeletionBody.parse({ scope: 'everything', code: '1' })).toThrow();
  });
});

describe('the deletion promise', () => {
  it('matches the 30 days the Privacy Policy and the delete-account page state', () => {
    expect(PURGE_WITHIN_DAYS).toBe(30);
  });

  it('is documented for the app', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, unknown> };
    expect(doc.paths['/v1/account/deletion']).toBeDefined();
  });
});
