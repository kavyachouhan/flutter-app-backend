import { describe, expect, it } from 'vitest';
import { createImportBody } from './imports.schemas.js';

describe('createImportBody schema validation', () => {
  const validPayload = {
    kind: 'items',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 1024,
    originalFilename: 'items.xlsx',
  };

  it('accepts valid payload without id', () => {
    const parsed = createImportBody.parse(validPayload);
    expect(parsed.kind).toBe('items');
    expect(parsed.sizeBytes).toBe(1024);
    expect(parsed.id).toBeUndefined();
  });

  it('accepts valid payload with client document UUID v4 or v7', () => {
    const v4Id = 'c0282bf2-f04f-40e9-b5a8-422bfcb54e3a';
    const v7Id = '018f2d5a-8b83-7186-8a76-06103632f70b';
    const parsedV4 = createImportBody.parse({
      ...validPayload,
      id: v4Id,
    });
    expect(parsedV4.id).toBe(v4Id);

    const parsedV7 = createImportBody.parse({
      ...validPayload,
      id: v7Id,
    });
    expect(parsedV7.id).toBe(v7Id);
  });

  it('rejects invalid UUID formats', () => {
    expect(() =>
      createImportBody.parse({
        ...validPayload,
        id: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('rejects non-positive file sizes (0 or negative)', () => {
    expect(() =>
      createImportBody.parse({
        ...validPayload,
        sizeBytes: 0,
      }),
    ).toThrow();

    expect(() =>
      createImportBody.parse({
        ...validPayload,
        sizeBytes: -50,
      }),
    ).toThrow();
  });

  it('accepts both xlsx and csv content types', () => {
    const csvParsed = createImportBody.parse({
      ...validPayload,
      contentType: 'text/csv',
    });
    expect(csvParsed.contentType).toBe('text/csv');
  });

  it('rejects unsupported content types (e.g. legacy xls or pdf)', () => {
    expect(() =>
      createImportBody.parse({
        ...validPayload,
        contentType: 'application/vnd.ms-excel',
      }),
    ).toThrow();

    expect(() =>
      createImportBody.parse({
        ...validPayload,
        contentType: 'application/pdf',
      }),
    ).toThrow();
  });

  it('trims originalFilename whitespace and enforces max length', () => {
    const parsed = createImportBody.parse({
      ...validPayload,
      originalFilename: '   catalogue.xlsx   ',
    });
    expect(parsed.originalFilename).toBe('catalogue.xlsx');

    expect(() =>
      createImportBody.parse({
        ...validPayload,
        originalFilename: 'a'.repeat(256),
      }),
    ).toThrow();
  });
});
