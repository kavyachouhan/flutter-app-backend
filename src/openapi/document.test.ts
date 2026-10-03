/**
 * The document is generated from every module's registrations at import time,
 * so a duplicate schema name, a path whose Zod schema cannot be converted, or
 * a tag nobody declared only fails when someone opens /v1/docs. Building it
 * here turns that into a test failure.
 */
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './document.js';

const document = buildOpenApiDocument() as {
  paths?: Record<string, Record<string, { tags?: string[] }>>;
  components?: { schemas?: Record<string, unknown> };
  tags?: { name: string }[];
};

describe('openapi document', () => {
  it('generates', () => {
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('declares every tag an operation uses', () => {
    const declared = new Set((document.tags ?? []).map((t) => t.name));
    const used = new Set<string>();
    for (const operations of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(operations)) {
        for (const tag of operation.tags ?? []) used.add(tag);
      }
    }
    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
  });

  it('exposes the print payload contract the clients generate models from', () => {
    expect(document.components?.schemas?.['PrintDocument']).toBeDefined();
    for (const path of [
      '/v1/invoices/{id}/print-payload',
      '/v1/credit-notes/{id}/print-payload',
      '/v1/payments/{id}/print-payload',
      '/v1/print-profiles',
      '/v1/custom-fields',
    ]) {
      expect(document.paths?.[path], path).toBeDefined();
    }
  });

  it('documents the upload and import lifecycles', () => {
    for (const path of [
      '/v1/uploads/sign',
      '/v1/uploads/url',
      '/v1/imports',
      '/v1/imports/{id}/ingest',
      '/v1/imports/{id}/analyse',
      '/v1/imports/{id}/apply',
      '/v1/imports/{id}/rows',
      '/v1/imports/{id}/cancel',
    ]) {
      expect(document.paths?.[path], path).toBeDefined();
    }
  });
});
