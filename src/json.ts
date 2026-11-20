import {
  DEFAULT_MAX_FROM_LENGTH,
  DEFAULT_MAX_NOTE_LENGTH,
  DEFAULT_MAX_TO_LENGTH,
  DEFAULT_STATUSES,
  listStatuses,
  makeProblem,
} from './defaults.ts';
import { checkFrom, checkTo, normalizeTarget } from './patterns.ts';
import type { ParseOptions, ParseResult, Problem, Rule } from './types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a JSON array of `{ from, to, status?, note?, force?, enabled? }` objects. `status` is a number or a
 * numeric string and defaults to 301; `enabled: false` leaves the item out. Items that can't be used are left
 * out and reported with their index.
 *
 * @example
 * parseJson('[{ "from": "/old", "to": "/new" }]')
 * // { rules: [{ index: 0, from: '/old', to: '/new', status: 301 }], problems: [] }
 */
export function parseJson(text: string, options: ParseOptions = {}): ParseResult {
  const statuses = options.statuses ?? DEFAULT_STATUSES;
  const maxFrom = options.maxFromLength ?? DEFAULT_MAX_FROM_LENGTH;
  const maxTo = options.maxToLength ?? DEFAULT_MAX_TO_LENGTH;
  const maxNote = options.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
  const rules: Rule[] = [];
  const problems: Problem[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { rules, problems: [makeProblem('parse-error', `Not valid JSON: ${(error as Error).message}`)] };
  }
  if (!Array.isArray(data))
    return { rules, problems: [makeProblem('parse-error', 'Expected a JSON array of redirect rules.')] };

  data.forEach((item: unknown, index) => {
    if (!isRecord(item)) {
      problems.push(makeProblem('parse-error', 'Expected an object with from, to and status.', { index }));
      return;
    }
    const from = typeof item.from === 'string' ? item.from.trim() : '';
    const at = { from, index };
    if (item.enabled === false) {
      problems.push(makeProblem('disabled', 'Turned off in the file.', at));
      return;
    }
    const rawStatus = item.status ?? 301;
    const status =
      typeof rawStatus === 'number' ? rawStatus : /^\d{3}$/.test(String(rawStatus).trim()) ? Number(rawStatus) : NaN;
    if (!statuses.includes(status)) {
      problems.push(
        makeProblem('invalid-status', `${String(rawStatus)} isn't a redirect type. Use ${listStatuses(statuses)}.`, at),
      );
      return;
    }
    const rawTo = typeof item.to === 'string' ? item.to.trim() : '';
    const to = status === 410 ? null : rawTo ? normalizeTarget(rawTo) : null;
    const bad = checkFrom(from, maxFrom) ?? checkTo(to, status, from, maxTo);
    if (bad) {
      problems.push(makeProblem(bad.code, bad.message, at));
      return;
    }
    if (status === 410 && rawTo)
      problems.push(makeProblem('gone-target', 'A 410 has no target, so the target is ignored.', at));
    const rule: Rule = { index, from, to, status };
    if (typeof item.note === 'string' && item.note) rule.note = item.note.slice(0, maxNote);
    if (item.force === true) rule.force = true;
    rules.push(rule);
  });
  return { rules, problems };
}

/**
 * Writes rules as a JSON array of `{ from, to, status, note?, force? }` objects.
 *
 * @example
 * toJson([{ from: '/old', to: '/new', status: 301 }])
 */
export function toJson(rules: readonly Rule[]): string {
  const out = rules.map((r) => {
    const item: Record<string, unknown> = { from: r.from, to: r.to, status: r.status };
    if (r.note) item.note = r.note;
    if (r.force) item.force = true;
    return item;
  });
  return `${JSON.stringify(out, null, 2)}\n`;
}
