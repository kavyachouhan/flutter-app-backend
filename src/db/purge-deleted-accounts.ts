/**
 * Runs the account purge by hand. The API already runs it daily on its own
 * (modules/account/purge-scheduler.ts, ACCOUNT_PURGE_DAILY_AT); this is for
 * checking what is due, rehearsing, or purging at once.
 *
 *   npm run purge:accounts                  list what is due, change nothing
 *   npm run purge:accounts -- --rehearse    do every delete, then roll back
 *   npm run purge:accounts -- --execute     purge now
 *   ... --tenant <id>                       only that business
 *
 * Uses the API's own database connection: the privileged step is the
 * `app.purge_deleted_business` function (migration 0051), so no owner
 * credentials are needed. Only businesses whose owner deleted them are ever
 * listed or purged. See modules/account/purge.ts for how one is purged.
 */
import { closePool } from './pool.js';
import { listDueDeletions, purgeBusiness, type PurgeOutcome } from '../modules/account/purge.js';

type Mode = 'list' | 'execute' | 'rehearse';

function describe(o: PurgeOutcome): string {
  switch (o.status) {
    case 'purged':
      return `PURGED: ${o.rowsDeleted} rows, ${o.usersDeleted} users, ${o.filesDeleted ?? 0} files.`;
    case 'rehearsed':
      return `REHEARSED: would delete ${o.rowsDeleted} rows and ${o.usersDeleted} users. Rolled back; files left alone.`;
    case 'already_purged':
      return 'Already purged (another run got there first).';
    case 'failed':
      return `FAILED, will be retried: ${o.error}`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: Mode = args.includes('--execute')
    ? 'execute'
    : args.includes('--rehearse')
      ? 'rehearse'
      : 'list';
  const onlyTenant = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : undefined;
  // `--tenant` with its id missing (an unset shell variable, say) must never
  // widen to every business — least of all with --execute.
  if (
    args.includes('--tenant') &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(onlyTenant ?? '')
  ) {
    console.error(
      '--tenant needs a business id, e.g. --tenant 9a6b8986-a41e-4ac1-a488-57132a331a75',
    );
    process.exitCode = 2;
    await closePool();
    return;
  }

  try {
    const due = await listDueDeletions({ onlyTenant });
    console.log(`${due.length} business deletion(s) to purge. Mode: ${mode}.`);
    if (onlyTenant && due.length === 0) {
      console.log('That business has not asked to be deleted, or is already purged.');
    }
    for (const d of due) {
      console.log(
        `\n${d.tenantId}  requested ${d.requestedAt.toISOString()}  due ${d.purgeDueAt.toISOString()}`,
      );
      if (mode === 'list') continue;
      const outcome = await purgeBusiness(d.tenantId, { rehearse: mode === 'rehearse' });
      console.log(`  ${describe(outcome)}`);
      if (outcome.status === 'failed') process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
