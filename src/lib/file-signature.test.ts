import { describe, expect, it } from 'vitest';
import { checkFileSignature } from './storage.js';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const text = (t: string): Uint8Array => new TextEncoder().encode(t);

describe('checkFileSignature', () => {
  it('refuses an empty file whatever it claims to be', () => {
    for (const ext of ['jpg', 'png', 'pdf', 'csv', 'zip']) {
      expect(checkFileSignature(ext, new Uint8Array()), ext).toBe('The file is empty.');
    }
  });

  it('accepts files that start the way their type says', () => {
    expect(checkFileSignature('jpg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(
      checkFileSignature('png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBeNull();
    expect(
      checkFileSignature('webp', bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    ).toBeNull();
    expect(checkFileSignature('pdf', text('%PDF-1.7\n'))).toBeNull();
    expect(checkFileSignature('docx', bytes(0x50, 0x4b, 0x03, 0x04, 0))).toBeNull();
    expect(checkFileSignature('gz', bytes(0x1f, 0x8b, 8))).toBeNull();
    expect(
      checkFileSignature('xls', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)),
    ).toBeNull();
    expect(checkFileSignature('csv', text('name,qty\nRice,2\n'))).toBeNull();
    expect(checkFileSignature('txt', text('नमस्ते — shop note'))).toBeNull();
  });

  it('refuses a file that is not what its name says', () => {
    expect(checkFileSignature('jpg', text('hello world'))).not.toBeNull();
    expect(checkFileSignature('png', bytes(0xff, 0xd8, 0xff))).not.toBeNull();
    expect(checkFileSignature('pdf', text('not a pdf'))).not.toBeNull();
    expect(checkFileSignature('docx', text('plain text'))).not.toBeNull();
    // PK 05 06 is an empty zip archive.
    expect(checkFileSignature('zip', bytes(0x50, 0x4b, 0x05, 0x06))).not.toBeNull();
  });

  it('refuses programs and scripts even when renamed', () => {
    for (const ext of ['jpg', 'pdf', 'zip', 'txt']) {
      expect(checkFileSignature(ext, bytes(0x4d, 0x5a, 0x90, 0, 3)), ext).toMatch(/program/);
      expect(checkFileSignature(ext, bytes(0x7f, 0x45, 0x4c, 0x46)), ext).toMatch(/program/);
      expect(checkFileSignature(ext, text('#!/bin/sh\nrm -rf /')), ext).toMatch(/program/);
    }
  });

  it('refuses a web page or script posing as text, and binary posing as text', () => {
    expect(checkFileSignature('txt', text('<!DOCTYPE html><html>'))).toMatch(/web page/);
    expect(checkFileSignature('csv', text('  <script>alert(1)</script>'))).toMatch(/web page/);
    expect(checkFileSignature('txt', text('<svg onload="x()">'))).toMatch(/web page/);
    expect(checkFileSignature('csv', bytes(0x61, 0x00, 0x62))).toMatch(/plain text/);
  });

  it('refuses an extension it does not know', () => {
    expect(checkFileSignature('exe', text('abc'))).toMatch(/not accepted/);
  });
});
