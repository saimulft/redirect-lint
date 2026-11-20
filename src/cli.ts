#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { flatten, lint } from './analyze.ts';
import { detectFormat, formatFromName, parse, serialize } from './formats.ts';
import { livePathsFromFiles } from './pages.ts';
import type { Format, Problem, Rule, Severity } from './types.ts';

const HELP = `redirect-lint: check redirect rules for loops, chains, clashes and mistakes.

Usage
  redirect-lint <file> [options]

Options
  -f, --format <type>   csv, redirects or json. Default: from the file name or content.
      --pages <dir>     A built site folder. Each .html file is a live page; redirects that hide one are reported.
      --flatten         Collapse chains and print the final rules, in the file's format.
      --out <file>      With --flatten, write the rules to a file instead. A .csv, .json or _redirects name sets the format.
      --max-rows <n>    Most rows a CSV file may have. Default: 5000.
      --json            Print the result as JSON.
  -v, --version         Print the version.
  -h, --help            Print this help.

Exit codes
  0  no errors (warnings and notes don't fail the run)
  1  the rules have errors
  2  the command was used wrongly, or a file couldn't be read
`;

class UsageError extends Error {}

const ORDER: Severity[] = ['error', 'warning', 'info'];
const TITLES: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notes' };

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Every .html file under a folder, as paths relative to it. */
function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(join(current, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        out.push(relative(dir, join(current, entry.name)));
      }
    }
  };
  walk(dir);
  return out;
}

const place = (p: Problem): string =>
  p.line !== undefined ? `line ${p.line}` : p.index !== undefined ? `index ${p.index}` : '';

/** The message, led by the rule's From when the message doesn't name it. */
const describe = (p: Problem): string =>
  p.from && !p.message.includes(p.from) ? `${p.from}: ${p.message}` : p.message;

function report(problems: Problem[]): string {
  const lines: string[] = [];
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const severity of ORDER) {
    const group = problems.filter((p) => p.severity === severity);
    counts[severity] = group.length;
    if (!group.length) continue;
    const width = Math.max(...group.map((p) => place(p).length));
    const codeWidth = Math.max(...group.map((p) => p.code.length));
    lines.push(`${TITLES[severity]} (${group.length})`);
    for (const p of group) lines.push(`  ${place(p).padEnd(width)}  ${p.code.padEnd(codeWidth)}  ${describe(p)}`);
    lines.push('');
  }
  return lines.join('\n');
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(problems: Problem[], ruleCount: number): string {
  const count = (s: Severity) => problems.filter((p) => p.severity === s).length;
  if (!problems.length) return `No problems found in ${plural(ruleCount, 'rule')}.`;
  const parts = [plural(count('error'), 'error'), plural(count('warning'), 'warning')];
  if (count('info')) parts.push(plural(count('info'), 'note'));
  return `${parts.join(', ')} in ${plural(ruleCount, 'rule')}.`;
}

function parseFormat(value: string | undefined): Format | undefined {
  if (value === undefined) return undefined;
  if (value === 'csv' || value === 'redirects' || value === 'json') return value;
  throw new UsageError(`Unknown format "${value}". Use csv, redirects or json.`);
}

function run(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f' },
        pages: { type: 'string' },
        flatten: { type: 'boolean' },
        out: { type: 'string' },
        'max-rows': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message.split('. ')[0]);
  }
  if (values.help) {
    out(HELP);
    return 0;
  }
  if (values.version) {
    out(`${readVersion()}\n`);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'Pass one file.' : 'Pass the file to check.');
  if (values.out !== undefined && !values.flatten) throw new UsageError('--out needs --flatten.');
  const file = positionals[0];
  const forced = parseFormat(values.format);
  let maxRows: number | undefined;
  if (values['max-rows'] !== undefined) {
    maxRows = Number(values['max-rows']);
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new UsageError('--max-rows needs a whole number above 0.');
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`Can't read ${file}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}.`);
  }
  let livePaths: string[] | undefined;
  if (values.pages !== undefined) {
    try {
      if (!statSync(values.pages).isDirectory()) throw new Error('not a folder');
      livePaths = livePathsFromFiles(htmlFiles(values.pages));
    } catch {
      throw new UsageError(`Can't read the folder ${values.pages}.`);
    }
  }

  const format = forced ?? detectFormat(text, file);
  const parsed = parse(text, format, { maxRows });
  const rules = parsed.rules;
  let flattened: Rule[] | undefined;
  let leftOut = 0;
  let found: Problem[];
  if (values.flatten) {
    const result = flatten(rules, { livePaths });
    flattened = result.rules;
    found = result.problems;
    leftOut = result.counts.dropped + parsed.problems.filter((p) => p.code !== 'gone-target').length;
  } else {
    found = lint(rules, { livePaths });
  }
  const position = (p: Problem) => p.line ?? p.index ?? Number.MAX_SAFE_INTEGER;
  const problems = [...parsed.problems, ...found].sort((a, b) => position(a) - position(b));
  const failed = problems.some((p) => p.severity === 'error');

  // A name like rules.csv or _redirects picks the output format, so --out can convert between formats.
  const outFormat = (values.out !== undefined ? formatFromName(values.out) : undefined) ?? format;
  const serialized = flattened ? serialize(flattened, outFormat) : '';
  if (flattened && values.out !== undefined) {
    try {
      writeFileSync(values.out, serialized);
    } catch (error) {
      throw new UsageError(`Can't write ${values.out}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}.`);
    }
  }

  if (values.json) {
    const sum = (s: Severity) => problems.filter((p) => p.severity === s).length;
    out(
      `${JSON.stringify(
        {
          file,
          format,
          rules: rules.length,
          problems,
          summary: { errors: sum('error'), warnings: sum('warning'), info: sum('info') },
          ...(flattened ? { flattened, ...(values.out !== undefined ? { out: values.out } : {}) } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return failed ? 1 : 0;
  }

  // With --flatten and no --out the rules go to stdout, so the report moves to stderr.
  const say = flattened && values.out === undefined ? err : out;
  say(`${file} (${format}, ${plural(rules.length, 'rule')})\n\n`);
  const body = report(problems);
  if (body) say(`${body}\n`);
  say(`${summary(problems, rules.length)}\n`);
  if (flattened) {
    if (values.out !== undefined) say(`Wrote ${plural(flattened.length, 'rule')} to ${values.out}.\n`);
    else out(serialized);
    if (leftOut) say(`${plural(leftOut, 'rule')} left out of the flattened rules (see above).\n`);
  }
  return failed ? 1 : 0;
}

try {
  process.exitCode = run(
    process.argv.slice(2),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`redirect-lint: ${error.message}\nRun redirect-lint --help for usage.\n`);
  process.exitCode = 2;
}
