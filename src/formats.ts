import { parseCsv, toCsv } from './csv.ts';
import { parseJson, toJson } from './json.ts';
import { parseRedirects, toRedirects } from './redirects-file.ts';
import type { Format, ParseOptions, ParseResult, Rule, SerializeOptions } from './types.ts';

/** The format a file name implies (`_redirects`, `.csv`, `.tsv`, `.json`), or undefined. */
export function formatFromName(fileName: string): Format | undefined {
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === '_redirects' || base.endsWith('.redirects')) return 'redirects';
  if (/\.(csv|tsv)$/.test(base)) return 'csv';
  if (base.endsWith('.json')) return 'json';
  return undefined;
}

/**
 * Guesses a file's format from its name (`_redirects`, `.csv`, `.tsv`, `.json`) and, failing that, from its
 * content: a leading `[` is JSON, whitespace-separated paths are a `_redirects` file, anything else CSV.
 *
 * @example
 * detectFormat('/old /new 301', '_redirects') // 'redirects'
 */
export function detectFormat(text: string, fileName?: string): Format {
  const named = formatFromName(fileName ?? '');
  if (named) return named;
  const body = text.replace(/^\uFEFF/, '').trimStart();
  if (body.startsWith('[')) return 'json';
  const first = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
  if (!/[,;]/.test(first) && /^\S+\s+\S+/.test(first.trim()) && first.trim().startsWith('/')) return 'redirects';
  return 'csv';
}

/**
 * Reads rules in any supported format.
 *
 * @example
 * parse(fileText, 'redirects')
 */
export function parse(text: string, format: Format, options: ParseOptions = {}): ParseResult {
  if (format === 'redirects') return parseRedirects(text, options);
  if (format === 'json') return parseJson(text, options);
  return parseCsv(text, options);
}

/**
 * Writes rules in any supported format.
 *
 * @example
 * serialize(rules, 'redirects')
 */
export function serialize(rules: readonly Rule[], format: Format, options: SerializeOptions = {}): string {
  if (format === 'redirects') return toRedirects(rules, options);
  if (format === 'json') return toJson(rules);
  return toCsv(rules);
}
