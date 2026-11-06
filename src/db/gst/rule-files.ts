/** Reads and checks the authored GST rule files under `data/gst-rules/`. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeRuleSet,
  ruleSetProblems,
  versionDates,
  type NotificationFile,
  type RuleBaseFile,
} from '../../domain/gst/rule-set-compose.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const RULES_DIR = path.join(REPO_ROOT, 'data', 'gst-rules');
export const SOURCES_DIR = path.join(REPO_ROOT, 'data', 'CBIC');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export interface RuleFiles {
  readonly base: RuleBaseFile;
  readonly notifications: readonly NotificationFile[];
}

export function loadRuleFiles(): RuleFiles {
  const dir = path.join(RULES_DIR, 'notifications');
  return {
    base: readJson<RuleBaseFile>(path.join(RULES_DIR, 'base.json')),
    notifications: readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson<NotificationFile>(path.join(dir, f))),
  };
}

/**
 * Every problem with the rule files: bad entries in any version, a notification file naming a
 * source that is not there, and a notification PDF in `data/CBIC` that no file accounts for.
 */
export function checkRuleFiles(files: RuleFiles = loadRuleFiles()): string[] {
  const problems: string[] = [];
  const cited = new Set<string>();

  for (const n of files.notifications) {
    if (n.sourceFile) {
      cited.add(path.basename(n.sourceFile));
      if (!existsSync(path.join(REPO_ROOT, n.sourceFile))) {
        problems.push(`${n.notification}: source file ${n.sourceFile} does not exist`);
      }
    }
    if (n.verificationStatus === 'primary_verified' && !n.sourceFile) {
      problems.push(`${n.notification}: primary_verified needs the source file it was verified against`);
    }
    if (n.treatment !== 'encoded' && !n.reason) {
      problems.push(`${n.notification}: a ${n.treatment} notification must say why`);
    }
  }

  if (existsSync(SOURCES_DIR)) {
    for (const f of readdirSync(SOURCES_DIR).filter((name) => name.toLowerCase().endsWith('.pdf'))) {
      if (!cited.has(f)) problems.push(`data/CBIC/${f} is not accounted for by any notification file`);
    }
  }

  for (const date of versionDates(files.notifications)) {
    try {
      const content = composeRuleSet(files.base, files.notifications, date);
      problems.push(...ruleSetProblems(content).map((p) => `${date}: ${p}`));
    } catch (error) {
      problems.push(`${date}: ${(error as Error).message}`);
    }
  }
  return problems;
}
