import {
  DEFAULT_MAX_FROM_LENGTH,
  DEFAULT_MAX_NOTE_LENGTH,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_TO_LENGTH,
  DEFAULT_STATUSES,
  formatNumber,
  listStatuses,
  makeProblem,
} from './defaults.ts';
import { checkFrom, checkTo, normalizeTarget } from './patterns.ts';
import type { ParseOptions, ParseResult, Problem, Rule } from './types.ts';

/** One row of a CSV file and the line it starts on. */
export interface CsvRow {
  line: number;
  cells: string[];
}

/** RFC 4180 rows. Takes a BOM, CRLF, quoted cells, and ; or tab when the first line uses them. */
export function splitCsv(text: string): CsvRow[] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = '';
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows;
}

const HEADERS = {
  from: ['from', 'source', 'source url', 'old url', 'old path', 'old', 'url', 'redirect from'],
  to: ['to', 'target', 'target url', 'destination', 'new url', 'new path', 'new', 'redirect to'],
  code: ['code', 'http code', 'status code', 'action_code', 'redirect type'],
  status: ['status'],
  note: ['note', 'notes', 'title', 'description', 'comment'],
  regex: ['regex'],
  enabled: ['enabled', 'active'],
};
type Column = keyof typeof HEADERS;

function headerColumns(cells: string[]): Partial<Record<Column, number>> | null {
  const names = cells.map((c) => c.trim().toLowerCase());
  const columns: Partial<Record<Column, number>> = {};
  for (const [column, aliases] of Object.entries(HEADERS) as [Column, string[]][]) {
    const i = names.findIndex((n) => aliases.includes(n));
    if (i !== -1) columns[column] = i;
  }
  return columns.from !== undefined && (columns.to !== undefined || columns.code !== undefined) ? columns : null;
}

const OFF = /^(0|no|false|off|disabled|inactive)$/i;

/** "https://example.com/old?x=1" → "/old?x=1"; "old-page" → "/old-page". */
function asPath(value: string): string {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const url = new URL(v);
      return `${url.pathname}${url.search}`;
    } catch {
      return v;
    }
  }
  return v && !v.startsWith('/') ? `/${v}` : v;
}

/** A target path gets a leading slash; full addresses stay as they are. */
function asTarget(value: string): string {
  const v = value.trim();
  return /^https?:\/\//i.test(v) || v.startsWith('/') ? v : `/${v}`;
}

/**
 * Reads CSV redirects: `from,to,status[,note]`, with or without a header row. A WordPress Redirection export
 * works too (source, target, regex, code, ..., title, status: enabled or disabled). `;` and tab separate cells
 * when the first line uses them. Rows that can't be used are left out and reported.
 *
 * @example
 * parseCsv('from,to,status\n/old,/new,301')
 * // { rules: [{ line: 2, from: '/old', to: '/new', status: 301, note: '' }], problems: [] }
 */
export function parseCsv(text: string, options: ParseOptions = {}): ParseResult {
  const statuses = options.statuses ?? DEFAULT_STATUSES;
  const maxFrom = options.maxFromLength ?? DEFAULT_MAX_FROM_LENGTH;
  const maxTo = options.maxToLength ?? DEFAULT_MAX_TO_LENGTH;
  const maxNote = options.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const all = splitCsv(text);
  const header = all.length ? headerColumns(all[0].cells) : null;
  const col: Partial<Record<Column, number>> = header ?? { from: 0, to: 1, code: 2, note: 3 };
  const rules: Rule[] = [];
  const problems: Problem[] = [];

  const data = all.filter((row, i) => !(header && i === 0) && row.cells.some((c) => c.trim()));
  if (data.length > maxRows)
    return {
      rules,
      problems: [
        makeProblem(
          'parse-error',
          `That file has ${formatNumber(data.length)} rows. Import up to ${formatNumber(maxRows)} at a time.`,
        ),
      ],
    };

  for (const { line, cells } of data) {
    const get = (c: Column) => (col[c] === undefined ? '' : (cells[col[c]!] ?? '').trim());
    const from = asPath(get('from'));
    const rawTo = get('to');
    // Redirection's "status" column says enabled or disabled; elsewhere it may hold the code.
    const statusCell = get('status');
    const codeCell = get('code') || (/^\d{3}$/.test(statusCell) ? statusCell : '');
    const status = codeCell ? Number(codeCell) : 301;
    const note = get('note').slice(0, maxNote);
    const at = { from, line };
    if (/^(1|true|yes)$/i.test(get('regex'))) {
      problems.push(
        makeProblem('unsupported', "Regex redirects aren't supported. Add it as a wildcard, such as /blog/*.", at),
      );
      continue;
    }
    if (OFF.test(get('enabled')) || (!/^\d{3}$/.test(statusCell) && OFF.test(statusCell))) {
      problems.push(makeProblem('disabled', 'Turned off in the file.', at));
      continue;
    }
    if (!/^\d{3}$/.test(String(status)) || !statuses.includes(status)) {
      problems.push(
        makeProblem('invalid-status', `${codeCell} isn't a redirect type. Use ${listStatuses(statuses)}.`, at),
      );
      continue;
    }
    const to = status === 410 ? null : rawTo ? normalizeTarget(asTarget(rawTo)) : null;
    const bad = checkFrom(from, maxFrom) ?? checkTo(to, status, from, maxTo);
    if (bad) {
      problems.push(makeProblem(bad.code, bad.message, at));
      continue;
    }
    if (status === 410 && rawTo)
      problems.push(makeProblem('gone-target', 'A 410 has no target, so the target is ignored.', at));
    rules.push({ line, from: from.trim(), to, status, note });
  }
  return { rules, problems };
}

const cell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * Writes rules as CSV with a `from,to,status,note` header row.
 *
 * @example
 * toCsv([{ from: '/old', to: '/new', status: 301 }])
 * // 'from,to,status,note\n/old,/new,301,\n'
 */
export function toCsv(rules: readonly Rule[]): string {
  const lines = ['from,to,status,note'];
  for (const r of rules) lines.push([r.from, r.to ?? '', String(r.status), r.note ?? ''].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
