import {
  DEFAULT_MAX_FROM_LENGTH,
  DEFAULT_MAX_TO_LENGTH,
  DEFAULT_STATUSES,
  listStatuses,
  makeProblem,
} from './defaults.ts';
import { checkFrom, checkTo, normalizeTarget } from './patterns.ts';
import type { ParseOptions, ParseResult, Problem, ProblemCode, Rule, SerializeOptions } from './types.ts';

/** `Country=us`, `id=:id`: how Netlify writes query matching and conditions. */
const KEY_VALUE = /^[A-Za-z0-9_.[\]-]+=/;
const STATUS = /^(\d{3})(!?)$/;

/**
 * Reads a Netlify or Cloudflare Pages `_redirects` file: `from to [status][!]` per line, with `#` comments and
 * blank lines. Splats (`/blog/*` to `/news/:splat`) and `:placeholders` are understood. Query matching, conditions,
 * host-specific rules and statuses that aren't redirects (200 rewrites, 404 pages) are left out and reported as
 * `unsupported`, not guessed at.
 *
 * @example
 * parseRedirects('/old /new 301\n/blog/* /news/:splat')
 */
export function parseRedirects(text: string, options: ParseOptions = {}): ParseResult {
  const statuses = options.statuses ?? DEFAULT_STATUSES;
  const maxFrom = options.maxFromLength ?? DEFAULT_MAX_FROM_LENGTH;
  const maxTo = options.maxToLength ?? DEFAULT_MAX_TO_LENGTH;
  const rules: Rule[] = [];
  const problems: Problem[] = [];

  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n|\r/)
    .forEach((raw, i) => {
      const line = i + 1;
      const tokens: string[] = [];
      for (const token of raw.trim().split(/\s+/)) {
        if (token.startsWith('#')) break;
        if (token) tokens.push(token);
      }
      if (!tokens.length) return;
      const from = tokens[0];
      const skip = (code: ProblemCode, message: string) => problems.push(makeProblem(code, message, { from, line }));

      if (/^[a-z][a-z0-9+.-]*:/i.test(from))
        return skip('unsupported', 'Rules that start from a full address (host-specific rules) are not supported.');
      if (from.includes('?'))
        return skip(
          'unsupported',
          'Query strings in the From are not supported. Matching on query parameters needs the host.',
        );

      let at = 1;
      const queries: string[] = [];
      while (at < tokens.length && KEY_VALUE.test(tokens[at])) queries.push(tokens[at++]);
      if (at >= tokens.length)
        return skip(
          'parse-error',
          queries.length
            ? 'Expected a target after the query parameters.'
            : 'Expected "from to [status]", but there is no target.',
        );
      if (queries.length)
        return skip('unsupported', `Query parameter matching (${queries.join(' ')}) is not supported.`);
      const rawTo = tokens[at++];

      let status = 301;
      let force = false;
      const statusToken = at < tokens.length ? STATUS.exec(tokens[at]) : null;
      if (statusToken) {
        status = Number(statusToken[1]);
        force = statusToken[2] === '!';
        at++;
      }
      const extra = tokens.slice(at);
      if (extra.length) {
        return extra.every((t) => KEY_VALUE.test(t))
          ? skip('unsupported', `Conditions (${extra.join(' ')}) are not supported.`)
          : skip('parse-error', `Unexpected "${extra[0]}" after the status.`);
      }
      if (!statuses.includes(status)) {
        return skip(
          'unsupported',
          status === 200
            ? '200 rewrites and proxies are not redirects, so they are not checked.'
            : `${status} is not a redirect type this check handles (${listStatuses(statuses)}).`,
        );
      }

      const to = status === 410 ? null : normalizeTarget(rawTo);
      const bad = checkFrom(from, maxFrom) ?? checkTo(to, status, from, maxTo);
      if (bad) return skip(bad.code, bad.message);
      const rule: Rule = { line, from, to, status };
      if (force) rule.force = true;
      rules.push(rule);
    });
  return { rules, problems };
}

/**
 * Writes rules as a `_redirects` file, in the order given. A trailing `/*` target becomes `/:splat`, `force` becomes
 * `!`, and notes become comments above their rule.
 *
 * @example
 * toRedirects([{ from: '/blog/*', to: '/news/*', status: 301 }])
 * // '/blog/*  /news/:splat  301\n'
 */
export function toRedirects(rules: readonly Rule[], options: SerializeOptions = {}): string {
  const notes = options.notes ?? true;
  const gonePage = options.gonePage ?? '/410.html';
  const rows = rules.map((r) => {
    const target = r.to ?? gonePage;
    return {
      note: r.note,
      from: r.from,
      to: target.endsWith('/*') ? `${target.slice(0, -1)}:splat` : target,
      status: `${r.status}${r.force ? '!' : ''}`,
    };
  });
  // Long values (full addresses) don't set the column width.
  const width = (values: string[]) => Math.max(0, ...values.map((v) => v.length).filter((n) => n <= 48));
  const fromWidth = width(rows.map((r) => r.from));
  const toWidth = width(rows.map((r) => r.to));
  const lines: string[] = [];
  for (const r of rows) {
    const note = r.note?.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (notes && note) lines.push(`# ${note}`);
    lines.push(`${r.from.padEnd(fromWidth)}  ${r.to.padEnd(toWidth)}  ${r.status}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
