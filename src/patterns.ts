import { formatNumber } from './defaults.ts';

/*
 * Paths and the patterns rules are written in.
 *
 * - Paths compare without a trailing slash ("/a/" and "/a" are one page).
 * - "/blog/*" matches everything below /blog/ (not /blog itself). A target ending in /* gets the rest of the path:
 *   "/blog/*" to "/news/*" sends /blog/2024/hello to /news/2024/hello.
 * - ":id" matches one path segment, and ":id" in the target puts what it matched there.
 */

const PARAM = /^:[A-Za-z_][A-Za-z0-9_]*$/;

/** True for a placeholder segment such as `:id`. */
export const isParam = (segment: string): boolean => PARAM.test(segment);

/** The comparable form of a path: trimmed, without a trailing slash (the root stays "/"). */
export function pathKey(path: string): string {
  const p = path.trim();
  if (p.length <= 1 || !p.endsWith('/')) return p;
  return p.replace(/\/+$/, '') || '/';
}

export const isWildcard = (from: string): boolean => from.trim().endsWith('/*');
export const isExternal = (to: string): boolean => /^https?:\/\//i.test(to.trim());

/** A path split into segments, with a trailing `*` taken off as the splat. */
export interface Pattern {
  segments: string[];
  splat: boolean;
}

/** Reads a path (or a target that stays on the site) as a pattern. */
export function toPattern(path: string): Pattern {
  const body = pathKey(path).slice(1);
  const segments = body === '' ? [] : body.split('/');
  const splat = segments[segments.length - 1] === '*';
  if (splat) segments.pop();
  return { segments, splat };
}

/** What two rules with the same From share. Placeholder names don't matter: /a/:x and /a/:y are one pattern. */
export function patternKey(pattern: Pattern): string {
  const segments = pattern.segments.map((s) => (isParam(s) ? ':' : s));
  return `/${(pattern.splat ? [...segments, '*'] : segments).join('/')}`;
}

/** 0 for an exact path, 1 when it has placeholders, 2 when it ends in a wildcard. */
export const patternClass = (pattern: Pattern): 0 | 1 | 2 =>
  pattern.splat ? 2 : pattern.segments.some(isParam) ? 1 : 0;

/** What a pattern bound when it matched another one. */
export interface Bindings {
  params: Map<string, string>;
  /** What the wildcard matched, or null when the pattern has none. */
  rest: string | null;
}

/**
 * Checks whether every path matching `target` also matches `from`, and what `from`'s placeholders and wildcard
 * stand for if so. Segments of `target` that are themselves placeholders or wildcards only count as covered by
 * a placeholder or wildcard of `from`, so a partial overlap is never reported.
 */
export function cover(from: Pattern, target: Pattern): Bindings | null {
  const params = new Map<string, string>();
  for (let i = 0; i < from.segments.length; i++) {
    if (i >= target.segments.length) return null;
    const f = from.segments[i];
    const t = target.segments[i];
    if (isParam(f)) params.set(f, t);
    else if (f !== t) return null;
  }
  const rest = target.segments.slice(from.segments.length);
  if (!from.splat) return rest.length || target.splat ? null : { params, rest: null };
  if (!rest.length && !target.splat) return null;
  return { params, rest: (target.splat ? [...rest, '*'] : rest).join('/') };
}

/** Puts what `from`'s placeholders and wildcard matched into a target. */
export function substitute(to: string, bindings: Bindings): string {
  const parts = to.split('/');
  return parts
    .map((part, i) => {
      if (isParam(part)) return bindings.params.get(part) ?? part;
      if (part === '*' && i === parts.length - 1 && bindings.rest !== null) return bindings.rest;
      return part;
    })
    .join('/');
}

/** "/news/:splat" → "/news/*": the `_redirects` spelling of a wildcard target becomes the one used inside. */
export function normalizeTarget(to: string): string {
  return to.endsWith('/:splat') ? `${to.slice(0, -'splat'.length - 1)}*` : to;
}

/** A problem with a path or target: `invalid-*` when it is wrong, `unsupported` when it is right but not handled. */
export interface Check {
  code: 'invalid-from' | 'invalid-to' | 'unsupported';
  message: string;
}

const invalid = (code: 'invalid-from' | 'invalid-to', message: string): Check => ({ code, message });

const placeholders = (path: string): string[] => path.split('/').filter((s) => s.startsWith(':'));

/** What's wrong with a From path, or null. */
export function checkFrom(from: string, maxLength: number): Check | null {
  const p = from.trim();
  if (!p) return invalid('invalid-from', 'Add the path to redirect from.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p))
    return invalid('invalid-from', 'Use a path on this site, such as /old-page, not a full address.');
  if (!p.startsWith('/')) return invalid('invalid-from', 'Start the path with /.');
  if (p.startsWith('//')) return invalid('invalid-from', 'Start the path with a single /.');
  if (/\s/.test(p)) return invalid('invalid-from', "A path can't contain spaces.");
  if (p.includes('#')) return invalid('invalid-from', 'Leave out the # part: browsers never send it.');
  const star = p.indexOf('*');
  if (star !== -1 && (star !== p.length - 1 || !p.endsWith('/*')))
    return {
      code: 'unsupported',
      message: 'Wildcards are only supported at the end of a path, after a slash, such as /blog/*.',
    };
  const names = placeholders(p);
  for (const name of names) {
    if (name === ':splat') return invalid('invalid-from', 'Use * at the end of the path for a wildcard, not :splat.');
    if (!isParam(name))
      return invalid('invalid-from', `${name} isn't a placeholder. Use letters, digits and _, like :id.`);
  }
  if (new Set(names).size !== names.length) return invalid('invalid-from', 'A placeholder can only appear once.');
  if (p.length > maxLength)
    return invalid('invalid-from', `Keep the path under ${formatNumber(maxLength)} characters.`);
  return null;
}

/** What's wrong with a target, or null. A 410's target is ignored. `to` is read with `:splat` already turned into `*`. */
export function checkTo(to: string | null, status: number, from: string, maxLength: number): Check | null {
  if (status === 410) return null;
  const t = (to ?? '').trim();
  if (!t) return invalid('invalid-to', 'Add where it redirects to, or make it a 410.');
  if (/\s/.test(t)) return invalid('invalid-to', "The target can't contain spaces.");
  if (!isExternal(t) && (!t.startsWith('/') || t.startsWith('//')))
    return invalid('invalid-to', 'Use a path that starts with / or a full address with https://.');
  const star = t.indexOf('*');
  if (star !== -1) {
    if (star !== t.length - 1 || !t.endsWith('/*'))
      return { code: 'unsupported', message: 'Put the * at the end of the target, after a slash, such as /news/*.' };
    if (!isWildcard(from)) return invalid('invalid-to', 'A * in the target needs a wildcard From, such as /blog/*.');
  }
  const defined = new Set(placeholders(from.trim()));
  for (const name of placeholders(t)) {
    if (name === ':splat')
      return {
        code: 'unsupported',
        message: ':splat is only supported at the end of the target, such as /news/:splat.',
      };
    if (isParam(name) && !defined.has(name))
      return invalid('invalid-to', `The target uses ${name}, which the From doesn't define.`);
  }
  if (t.length > maxLength)
    return invalid('invalid-to', `Keep the target under ${formatNumber(maxLength)} characters.`);
  return null;
}
