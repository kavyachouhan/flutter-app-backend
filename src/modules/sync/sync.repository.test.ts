import { describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { SYNC_TABLES } from './sync.registry.js';
import { branch } from './sync.repository.js';
import { payloadHash } from './operation-keys.js';

const entry = (entity: string) => {
  const found = SYNC_TABLES.find((t) => t.entity === entity);
  if (!found) throw new Error(`no ${entity} in the registry`);
  return found;
};

describe('the change feed query for each table', () => {
  it('strips only the tenant column from an ordinary table', () => {
    const sql = branch(entry('items'));
    expect(sql).toContain("(to_jsonb(t) - ARRAY['tenant_id'])");
    expect(sql).not.toMatch(/current_date/);
  });

  it('sends only recent invoice lines, and never the cost of goods', () => {
    const sql = branch(entry('invoice_lines'));
    expect(sql).toContain(`t.document_date >= current_date - ${env.SYNC_RETURN_WINDOW_DAYS}`);
    expect(sql).toContain("ARRAY['tenant_id', 'cogs_amount']");
  });

  it('sends only recent credit-note lines', () => {
    const sql = branch(entry('credit_note_lines'));
    expect(sql).toContain(`t.document_date >= current_date - ${env.SYNC_RETURN_WINDOW_DAYS}`);
  });

  it('keeps the window a plain integer, since it is written into the query', () => {
    expect(Number.isInteger(env.SYNC_RETURN_WINDOW_DAYS)).toBe(true);
    expect(env.SYNC_RETURN_WINDOW_DAYS).toBeGreaterThan(0);
  });

  it('still filters by tenant and cursor on a windowed table', () => {
    const sql = branch(entry('invoice_lines'));
    expect(sql).toContain('t.tenant_id = app.current_tenant_id()');
    expect(sql).toContain('t.server_seq > $1');
  });
});

describe('what an operation id is bound to', () => {
  it('is the same for the same payload however its keys are ordered', () => {
    const a = payloadHash('customer.update', { id: '1', patch: { name: 'A', city: 'B' } });
    const b = payloadHash('customer.update', { patch: { city: 'B', name: 'A' }, id: '1' });
    expect(a.equals(b)).toBe(true);
  });

  it('differs when the payload or the type differs', () => {
    const base = payloadHash('customer.update', { id: '1', patch: { name: 'A' } });
    expect(base.equals(payloadHash('customer.update', { id: '1', patch: { name: 'B' } }))).toBe(false);
    expect(base.equals(payloadHash('customer.delete', { id: '1', patch: { name: 'A' } }))).toBe(false);
  });

  it('treats an absent key and an undefined one alike, as JSON does', () => {
    const a = payloadHash('x', { id: '1', note: undefined });
    const b = payloadHash('x', { id: '1' });
    expect(a.equals(b)).toBe(true);
  });
});
