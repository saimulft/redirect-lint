import {
  DEFAULT_MAX_FROM_LENGTH,
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_TO_LENGTH,
  DEFAULT_STATUSES,
  formatNumber,
  listStatuses,
  makeProblem,
} from './defaults.ts';
import {
  checkFrom,
  checkTo,
  cover,
  isExternal,
  isParam,
  normalizeTarget,
  patternClass,
  patternKey,
  substitute,
  toPattern,
  type Bindings,
  type Pattern,
} from './patterns.ts';
import type { FlattenResult, LintOptions, Problem, Rule, RuleLocation } from './types.ts';

/** A rule that passed the checks, ready to be followed. */
interface Compiled {
  rule: Rule;
  loc: RuleLocation;
  from: string;
  to: string | null;
  status: number;
  pattern: Pattern;
  key: string;
  /** 0 exact, 1 placeholders, 2 wildcard. */
  cls: 0 | 1 | 2;
  literals: number;
  /** Position in the input. */
  pos: number;
}

/** A problem and the rules it involves, which `planImport` uses to tell which problems an import causes. */
export interface Finding {
  problem: Problem;
  rules: Rule[];
}

export interface Analysis {
  findings: Finding[];
  served: { rule: Rule; to: string | null; status: number; collapsed: boolean }[];
}

/** Where a rule sits, for problems: its own line or index, or else its position in the array. */
export const defaultLocate = (rule: Rule, pos: number): RuleLocation => {
  if (rule.line === undefined && rule.index === undefined) return { index: pos };
  return withLocation(rule);
};

/** A rule's own line and index, leaving out the one it doesn't have. */
const withLocation = (rule: RuleLocation): RuleLocation => ({
  ...(rule.line !== undefined ? { line: rule.line } : {}),
  ...(rule.index !== undefined ? { index: rule.index } : {}),
});

const where = (c: Compiled): string =>
  c.loc.line !== undefined ? `line ${c.loc.line}` : c.loc.index !== undefined ? `index ${c.loc.index}` : c.from;

/** Most specific first: exact paths, then placeholders, then wildcards with the longest prefix. */
function compare(a: Compiled, b: Compiled): number {
  if (a.cls !== b.cls) return a.cls - b.cls;
  if (a.cls === 2 && a.pattern.segments.length !== b.pattern.segments.length)
    return b.pattern.segments.length - a.pattern.segments.length;
  if (a.cls !== 0 && a.literals !== b.literals) return b.literals - a.literals;
  return a.from.localeCompare(b.from) || a.pos - b.pos;
}

const emptyBindings = (): Bindings => ({ params: new Map(), rest: null });

/**
 * Checks every rule, finds loops, chains, duplicates, shadowed rules and clashes with live pages, and works out
 * what each valid rule finally serves.
 */
export function analyze(
  input: readonly Rule[],
  options: LintOptions = {},
  locate: (rule: Rule, pos: number) => RuleLocation = defaultLocate,
): Analysis {
  const statuses = options.statuses ?? DEFAULT_STATUSES;
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const maxFrom = options.maxFromLength ?? DEFAULT_MAX_FROM_LENGTH;
  const maxTo = options.maxToLength ?? DEFAULT_MAX_TO_LENGTH;
  const findings: Finding[] = [];
  const found = (problem: Problem, rules: Rule[]) => findings.push({ problem, rules });

  // Valid rules, with the others reported.
  const all: Compiled[] = [];
  input.forEach((rule, pos) => {
    const loc = locate(rule, pos);
    const from = String(rule.from ?? '').trim();
    const status = Number(rule.status);
    const at = { from, ...loc };
    if (!statuses.includes(status)) {
      found(makeProblem('invalid-status', `${rule.status} isn't a redirect type. Use ${listStatuses(statuses)}.`, at), [
        rule,
      ]);
      return;
    }
    const to = status === 410 ? null : normalizeTarget((rule.to ?? '').trim());
    const bad = checkFrom(from, maxFrom) ?? checkTo(to, status, from, maxTo);
    if (bad) {
      found(makeProblem(bad.code, bad.message, at), [rule]);
      return;
    }
    if (status === 410 && (rule.to ?? '').trim())
      found(makeProblem('gone-target', 'A 410 has no target, so the target is ignored.', at), [rule]);
    const pattern = toPattern(from);
    all.push({
      rule,
      loc,
      from,
      to,
      status,
      pattern,
      key: patternKey(pattern),
      cls: patternClass(pattern),
      literals: pattern.segments.filter((s) => !isParam(s)).length,
      pos,
    });
  });
  const related = (list: Compiled[]) => list.map((c) => c.loc);

  // Duplicates: the first rule per From is the one a host uses.
  const byKey = new Map<string, Compiled>();
  const dupes = new Map<string, Compiled[]>();
  for (const c of all) {
    const first = byKey.get(c.key);
    if (first) dupes.set(c.key, [...(dupes.get(c.key) ?? [first]), c]);
    else byKey.set(c.key, c);
  }
  for (const group of dupes.values()) {
    const froms = [...new Set(group.map((c) => c.from))];
    found(
      makeProblem(
        'duplicate',
        froms.length > 1
          ? `${froms.join(' and ')} are the same path, so only ${group[0].from} is used.`
          : `${group.length} redirects start from ${group[0].from}, so only the first is used.`,
        { from: group[0].from, ...group[0].loc },
        related(group.slice(1)),
      ),
      group.map((c) => c.rule),
    );
  }
  const rules = all.filter((c) => byKey.get(c.key) === c);

  // Shadowed: an earlier wildcard or placeholder rule that covers everything this one matches.
  const earlier: Compiled[] = [];
  for (const c of rules) {
    const by = earlier.find((e) => cover(e.pattern, c.pattern));
    if (by)
      found(
        makeProblem(
          'shadowed',
          `${c.from} is never reached: ${by.from} (${where(by)}) matches the same paths first on hosts that use the first match.`,
          { from: c.from, ...c.loc },
          related([by]),
        ),
        [c.rule, by.rule],
      );
    if (c.cls > 0) earlier.push(c);
  }

  // Clashes: a From that is a live page, or a pattern over live pages.
  if (options.livePaths) {
    const live = [
      ...new Set([...options.livePaths].map((p) => patternKey(toPattern(p.startsWith('/') ? p : `/${p}`)))),
    ].sort();
    const livePatterns = live.map((p) => toPattern(p));
    const liveSet = new Set(live);
    for (const c of rules) {
      const at = { from: c.from, ...c.loc };
      if (c.cls === 0) {
        if (liveSet.has(c.key))
          found(
            makeProblem(
              'clash',
              c.rule.force
                ? `${c.from} is a live page and the redirect is forced, so the page can't be reached.`
                : `${c.from} is a live page. The redirect hides it on hosts that apply redirects first.`,
              at,
            ),
            [c.rule],
          );
        continue;
      }
      const covered = live.filter((_, i) => cover(c.pattern, livePatterns[i]));
      if (covered.length)
        found(
          makeProblem(
            'clash',
            covered.length === 1
              ? `${c.from} covers the live page ${covered[0]}.`
              : `${c.from} covers ${formatNumber(covered.length)} live pages, such as ${covered[0]}.`,
            at,
          ),
          [c.rule],
        );
    }
  }

  // Follow each rule to its end.
  const exact = new Map(rules.filter((c) => c.cls === 0).map((c) => [c.key, c]));
  const patterns = rules.filter((c) => c.cls > 0).sort(compare);
  const find = (target: Pattern): { rule: Compiled; bindings: Bindings } | null => {
    if (patternClass(target) === 0) {
      const hit = exact.get(patternKey(target));
      if (hit) return { rule: hit, bindings: emptyBindings() };
    }
    for (const p of patterns) {
      const bindings = cover(p.pattern, target);
      if (bindings) return { rule: p, bindings };
    }
    return null;
  };

  interface Followed {
    hops: Compiled[];
    to: string | null;
    gone: boolean;
    /** Index in hops where the loop starts, or -1. */
    loopAt: number;
    tooLong: boolean;
  }
  const follow = (start: Compiled): Followed => {
    const hops = [start];
    if (start.status === 410) return { hops, to: null, gone: true, loopAt: -1, tooLong: false };
    let target = start.to ?? '';
    while (!isExternal(target)) {
      const next = find(toPattern(target));
      if (!next) break;
      const seen = hops.indexOf(next.rule);
      if (seen !== -1) return { hops, to: target, gone: false, loopAt: seen, tooLong: false };
      hops.push(next.rule);
      if (hops.length > maxHops) return { hops, to: target, gone: false, loopAt: -1, tooLong: true };
      if (next.rule.status === 410) return { hops, to: null, gone: true, loopAt: -1, tooLong: false };
      target = substitute(next.rule.to ?? '', next.bindings);
    }
    return { hops, to: target, gone: false, loopAt: -1, tooLong: false };
  };

  const served: { c: Compiled; to: string | null; status: number; collapsed: boolean }[] = [];
  const loopGroups = new Map<string, { cycle: Compiled[]; leadIns: Compiled[] }>();
  for (const c of rules) {
    const f = follow(c);
    if (f.tooLong) {
      found(
        makeProblem(
          'loop',
          `${c.from} passes through more than ${maxHops} redirects without settling, so it isn't served.`,
          { from: c.from, ...c.loc },
          related(f.hops.slice(1)),
        ),
        f.hops.map((h) => h.rule),
      );
      continue;
    }
    if (f.loopAt !== -1) {
      const cycle = f.hops.slice(f.loopAt);
      const key = cycle
        .map((h) => h.key)
        .sort()
        .join('\n');
      const group = loopGroups.get(key) ?? { cycle, leadIns: [] };
      if (f.loopAt > 0 && !group.leadIns.includes(c)) group.leadIns.push(c);
      loopGroups.set(key, group);
      continue;
    }
    const to = f.gone ? null : f.to;
    const status = f.gone ? 410 : c.status;
    served.push({ c, to, status, collapsed: f.hops.length > 1 });
    if (f.hops.length > 1) {
      const path = [...f.hops.map((h) => h.from), to ?? '410 Gone'].join(' → ');
      found(
        makeProblem(
          'chain',
          to ? `${path}. Served as ${c.from} → ${to}.` : `${path}. Served as a 410 for ${c.from}.`,
          { from: c.from, ...c.loc },
          related(f.hops.slice(1)),
        ),
        f.hops.map((h) => h.rule),
      );
    }
  }
  for (const { cycle, leadIns } of loopGroups.values()) {
    const path = [...cycle.map((h) => h.from), cycle[0].from].join(' → ');
    const lead = leadIns.length
      ? ` ${leadIns.map((l) => l.from).join(', ')} ${leadIns.length === 1 ? 'leads' : 'lead'} into it and ${leadIns.length === 1 ? 'is' : 'are'} left out too.`
      : '';
    found(
      makeProblem(
        'loop',
        `${path} is a loop, so ${cycle.length === 1 ? "it isn't" : 'none of them is'} served.${lead}`,
        { from: cycle[0].from, ...cycle[0].loc },
        related([...cycle.slice(1), ...leadIns]),
      ),
      [...cycle, ...leadIns].map((h) => h.rule),
    );
  }

  served.sort((a, b) => compare(a.c, b.c));
  const position = (p: Problem) => p.line ?? p.index ?? Number.MAX_SAFE_INTEGER;
  findings.sort((a, b) => position(a.problem) - position(b.problem));
  return {
    findings,
    served: served.map(({ c, to, status, collapsed }) => ({ rule: c.rule, to, status, collapsed })),
  };
}

/**
 * Checks a rule set and returns what's wrong with it: malformed rules, loops, chains, duplicates, rules that an
 * earlier one hides, and (with `livePaths`) redirects that shadow live pages.
 *
 * @example
 * lint([{ from: '/a', to: '/b', status: 301 }, { from: '/b', to: '/a', status: 301 }])
 * // [{ code: 'loop', severity: 'error', message: '/a → /b → /a is a loop, ...', ... }]
 */
export function lint(rules: readonly Rule[], options: LintOptions = {}): Problem[] {
  return analyze(rules, options).findings.map((f) => f.problem);
}

/**
 * Returns the rule set a host should serve: chains collapsed to their final target, a chain into a 410 as a 410,
 * and loops, malformed rules and duplicate Froms left out. Exact paths come first, then placeholders, then
 * wildcards (longest first), so hosts that take the first match apply the most specific rule.
 *
 * @example
 * flatten([{ from: '/a', to: '/b', status: 301 }, { from: '/b', to: '/c', status: 301 }]).rules
 * // [{ from: '/a', to: '/c', status: 301 }, { from: '/b', to: '/c', status: 301 }]
 */
export function flatten(rules: readonly Rule[], options: LintOptions = {}): FlattenResult {
  const { findings, served } = analyze(rules, options);
  const out: Rule[] = served.map(({ rule, to, status }) => {
    const r: Rule = { from: rule.from.trim(), to, status };
    if (rule.note) r.note = rule.note;
    if (rule.force) r.force = true;
    if (rule.line !== undefined) r.line = rule.line;
    if (rule.index !== undefined) r.index = rule.index;
    return r;
  });
  const collapsed = served.filter((s) => s.collapsed).length;
  return {
    rules: out,
    problems: findings.map((f) => f.problem),
    counts: { input: rules.length, output: out.length, collapsed, dropped: rules.length - out.length },
  };
}
