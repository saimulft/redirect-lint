import type { Problem, ProblemCode, RuleLocation, Severity } from './types.ts';

/** Statuses a rule may have unless the `statuses` option says otherwise. */
export const DEFAULT_STATUSES: readonly number[] = [301, 302, 303, 307, 308, 410];

export const DEFAULT_MAX_HOPS = 20;
export const DEFAULT_MAX_FROM_LENGTH = 500;
export const DEFAULT_MAX_TO_LENGTH = 1000;
export const DEFAULT_MAX_NOTE_LENGTH = 500;
export const DEFAULT_MAX_ROWS = 5000;

const SEVERITY: Record<ProblemCode, Severity> = {
  'parse-error': 'error',
  'invalid-from': 'error',
  'invalid-to': 'error',
  'invalid-status': 'error',
  loop: 'error',
  unsupported: 'warning',
  chain: 'warning',
  clash: 'warning',
  duplicate: 'warning',
  shadowed: 'warning',
  disabled: 'info',
  'gone-target': 'info',
};

/** Builds a problem with the severity its code carries. */
export function makeProblem(
  code: ProblemCode,
  message: string,
  at: RuleLocation & { from?: string } = {},
  related: RuleLocation[] = [],
): Problem {
  const problem: Problem = { code, severity: SEVERITY[code], message };
  if (at.from !== undefined) problem.from = at.from;
  if (at.line !== undefined) problem.line = at.line;
  if (at.index !== undefined) problem.index = at.index;
  const others = related.filter((r) => r.line !== undefined || r.index !== undefined);
  if (others.length) problem.related = others;
  return problem;
}

/** "301, 302 or 410". */
export function listStatuses(statuses: readonly number[]): string {
  const list = [...statuses].sort((a, b) => a - b).map(String);
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

export const formatNumber = (n: number): string => n.toLocaleString('en');
