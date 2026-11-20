import { analyze, defaultLocate } from './analyze.ts';
import { patternKey, toPattern } from './patterns.ts';
import type { LintOptions, Problem, Rule, RuleLocation } from './types.ts';

/** What an import would do with one incoming rule. */
export interface ImportRow {
  rule: Rule;
  action: 'add' | 'update' | 'skip';
  /** Why a rule is skipped, or what an update replaces. */
  reason?: string;
  /** The rule an update replaces. */
  existing?: Rule;
}

/** What `planImport` returns. */
export interface ImportPlan {
  /** One row per incoming rule, in the order given. */
  rows: ImportRow[];
  adds: Rule[];
  updates: { rule: Rule; existing: Rule }[];
  /** The loops, chains, clashes and duplicates the incoming rules would take part in once live. */
  problems: Problem[];
}

const label = (rule: Rule, pos: number): string =>
  rule.line !== undefined ? `line ${rule.line}` : `index ${rule.index ?? pos}`;

/**
 * Plans an import of `incoming` rules into a site that already has `existing` ones: a rule whose From exists is an
 * update (or a skip when nothing changes), any other rule an add. A rule repeating an earlier incoming From is
 * skipped. `problems` are the ones the incoming rules would cause next to the existing set.
 *
 * @example
 * const { rules } = parseCsv(file);
 * const plan = planImport(rules, existingRules, { livePaths });
 * plan.adds.length; plan.updates.length; plan.problems;
 */
export function planImport(
  incoming: readonly Rule[],
  existing: readonly Rule[],
  options: LintOptions = {},
): ImportPlan {
  const byKey = new Map(existing.map((e) => [patternKey(toPattern(e.from)), e]));
  const seen = new Map<string, string>();
  const rows: ImportRow[] = [];
  const adds: Rule[] = [];
  const updates: ImportPlan['updates'] = [];
  const where = new Map<Rule, RuleLocation>();

  incoming.forEach((rule, pos) => {
    const place = defaultLocate(rule, pos);
    where.set(rule, place);
    const key = patternKey(toPattern(rule.from));
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      rows.push({ rule, action: 'skip', reason: `Same From as ${earlier}.` });
      return;
    }
    seen.set(key, label(rule, pos));
    const current = byKey.get(key);
    if (!current) {
      rows.push({ rule, action: 'add' });
      adds.push(rule);
      return;
    }
    const note = rule.note || current.note || '';
    if ((current.to ?? null) === rule.to && current.status === rule.status && (current.note ?? '') === note) {
      rows.push({ rule, action: 'skip', reason: 'Already there.', existing: current });
      return;
    }
    const merged: Rule = { ...rule, ...(note ? { note } : {}) };
    rows.push({
      rule: merged,
      action: 'update',
      reason: `Was ${current.status}${current.to ? ` to ${current.to}` : ''}.`,
      existing: current,
    });
    where.set(merged, place);
    updates.push({ rule: merged, existing: current });
  });

  // The rule set once the import is live: updates replace their existing rule in place. Only incoming rules have
  // a place in the incoming file; the site's own rules are named by their From.
  const replaced = new Map(updates.map((u) => [u.existing, u.rule]));
  const places = new Map<Rule, RuleLocation>();
  const copy = (rule: Rule, from = rule.from): Rule => {
    const c: Rule = { ...rule, from };
    places.set(c, where.get(rule) ?? {});
    return c;
  };
  const after: Rule[] = existing.map((e) => {
    const update = replaced.get(e);
    return update ? copy(update, e.from) : { ...e };
  });
  for (const a of adds) after.push(copy(a));

  const problems = analyze(after, options, (rule) => places.get(rule) ?? {})
    .findings.filter((f) => f.rules.some((r) => places.has(r)))
    .map(({ problem }) => {
      // A problem that starts at one of the site's own rules points at the incoming rule it involves.
      if (problem.line !== undefined || problem.index !== undefined || !problem.related?.length) return problem;
      const [first, ...others] = problem.related;
      const moved: Problem = { ...problem, ...first };
      if (others.length) moved.related = others;
      else delete moved.related;
      return moved;
    });
  return { rows, adds, updates, problems };
}
