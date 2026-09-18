/**
 * Builds `column = $n` assignments for a PATCH. Only keys present in
 * `columns` are used, so a request body can never name an arbitrary column.
 */
export function buildSet(
  patch: Record<string, unknown>,
  columns: Readonly<Record<string, string>>,
  firstIndex: number,
): { clause: string; values: unknown[] } {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    assignments.push(`${column} = $${firstIndex + values.length - 1}`);
  }
  return { clause: assignments.join(', '), values };
}

/**
 * pg serialises JS arrays as Postgres array literals, not JSON, so values bound
 * to jsonb parameters must be stringified explicitly.
 */
export function jsonParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Escapes LIKE wildcards so user search text matches literally. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}
