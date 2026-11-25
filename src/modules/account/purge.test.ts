import { beforeEach, describe, expect, it, vi } from 'vitest';

// The pool, scripted: what app.purge_deleted_business returns, and a log of
// every statement, so the order of files and rows can be checked.
const db = vi.hoisted(() => ({
  log: [] as string[],
  purgeResult: [] as { rows_deleted: string; users_deleted: number }[],
  purgeError: undefined as Error | undefined,
  due: [] as { tenantId: string; requestedAt: Date; purgeDueAt: Date }[],
}));

vi.mock('../../db/pool.js', () => {
  const query = (sql: string) => {
    db.log.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('app.purge_deleted_business')) {
      if (db.purgeError) return Promise.reject(db.purgeError);
      return Promise.resolve({ rows: db.purgeResult });
    }
    if (sql.includes('app.due_business_deletions')) return Promise.resolve({ rows: db.due });
    return Promise.resolve({ rows: [] });
  };
  return {
    pool: {
      query,
      connect: () => Promise.resolve({ query, release: () => db.log.push('release') }),
    },
  };
});

const { purgeBusiness, purgeDueDeletions } = await import('./purge.js');

const TENANT = '0190a000-0000-7000-8000-000000000001';

beforeEach(() => {
  db.log = [];
  db.purgeResult = [{ rows_deleted: '157', users_deleted: 1 }];
  db.purgeError = undefined;
  db.due = [];
});

describe('purgeBusiness', () => {
  it('deletes the stored files first, then the rows, in one committed transaction', async () => {
    const deleteFiles = vi.fn(() => {
      db.log.push('files');
      return Promise.resolve(17);
    });
    const outcome = await purgeBusiness(TENANT, { deleteFiles });
    expect(outcome).toEqual({
      tenantId: TENANT,
      status: 'purged',
      rowsDeleted: 157,
      usersDeleted: 1,
      filesDeleted: 17,
    });
    expect(db.log[0]).toBe('files');
    expect(db.log).toContain('BEGIN');
    expect(db.log.some((s) => s.startsWith('SET LOCAL lock_timeout'))).toBe(true);
    expect(db.log.at(-2)).toBe('COMMIT');
    expect(db.log.at(-1)).toBe('release');
  });

  it('when the files cannot be deleted, leaves the rows for the next run', async () => {
    const deleteFiles = vi.fn(() => Promise.reject(new Error('storage down')));
    const outcome = await purgeBusiness(TENANT, { deleteFiles });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('storage down');
    expect(db.log).toEqual([]);
  });

  it('a rehearsal rolls the rows back and never touches the files', async () => {
    const deleteFiles = vi.fn(() => Promise.resolve(17));
    const outcome = await purgeBusiness(TENANT, { rehearse: true, deleteFiles });
    expect(outcome.status).toBe('rehearsed');
    expect(deleteFiles).not.toHaveBeenCalled();
    expect(db.log).toContain('ROLLBACK');
    expect(db.log).not.toContain('COMMIT');
  });

  it('a business another run already purged is reported as such', async () => {
    db.purgeResult = [];
    const outcome = await purgeBusiness(TENANT, { deleteFiles: () => Promise.resolve(0) });
    expect(outcome.status).toBe('already_purged');
  });

  it('a database failure rolls back and is reported, not thrown', async () => {
    db.purgeError = new Error('canceling statement due to lock timeout');
    const outcome = await purgeBusiness(TENANT, { deleteFiles: () => Promise.resolve(0) });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('lock timeout');
    expect(db.log).toContain('ROLLBACK');
    expect(db.log.at(-1)).toBe('release');
  });
});

describe('purgeDueDeletions', () => {
  it('purges each due business in turn; one failing does not stop the rest', async () => {
    const other = '0190a000-0000-7000-8000-000000000002';
    db.due = [
      { tenantId: TENANT, requestedAt: new Date(), purgeDueAt: new Date() },
      { tenantId: other, requestedAt: new Date(), purgeDueAt: new Date() },
    ];
    const deleteFiles = vi.fn((id: string) =>
      id === TENANT ? Promise.reject(new Error('storage down')) : Promise.resolve(2),
    );
    const outcomes = await purgeDueDeletions({ deleteFiles });
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'purged']);
  });

  it('asks the database only for what is due by the given date', async () => {
    const dueBy = new Date('2026-12-01T00:00:00Z');
    await purgeDueDeletions({ dueBy });
    expect(db.log[0]).toContain('app.due_business_deletions');
  });
});
