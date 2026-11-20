import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv, planImport } from '../src/index.ts';
import { rule } from './helpers.ts';

describe('planImport', () => {
  const existing = [rule('/same', '/x'), { ...rule('/change', '/x'), note: 'Keep me' }, rule('/b', '/a')];

  it('plans adds, updates and skips, and reports the loops it would make', () => {
    const csv = [
      '/same,/x,301',
      '/change/,/y,302',
      '/a,/b,301,Makes a loop',
      '/new,/fresh',
      '/new,/again',
      'no-slash,/x,301',
    ].join('\n');
    const plan = planImport(parseCsv(csv).rules, existing);
    assert.deepEqual(
      plan.rows.map((r) => [r.rule.line, r.action]),
      [
        [1, 'skip'],
        [2, 'update'],
        [3, 'add'],
        [4, 'add'],
        [5, 'skip'],
        [6, 'add'],
      ],
    );
    assert.equal(plan.rows[0].reason, 'Already there.');
    assert.equal(plan.rows[1].reason, 'Was 301 to /x.');
    assert.equal(plan.rows[1].rule.note, 'Keep me');
    assert.equal(plan.rows[4].reason, 'Same From as line 4.');
    assert.equal(plan.rows[5].rule.from, '/no-slash');
    assert.deepEqual(
      plan.updates.map((u) => [u.existing.from, u.rule.to, u.rule.status]),
      [['/change', '/y', 302]],
    );
    assert.deepEqual(
      plan.adds.map((a) => a.from),
      ['/a', '/new', '/no-slash'],
    );
    const [loop, ...rest] = plan.problems;
    assert.deepEqual(rest, []);
    assert.equal(loop.code, 'loop');
    assert.match(loop.message, /\/b → \/a → \/b is a loop/);
    // The loop starts at the incoming rule, so it points at its line.
    assert.equal(loop.line, 3);
  });

  it('only reports problems the incoming rules take part in', () => {
    const site = [rule('/a', '/b'), rule('/b', '/c'), rule('/p', '/q'), rule('/q', '/p')];
    const plan = planImport([rule('/z', '/y')], site);
    assert.deepEqual(plan.problems, []);
  });

  it('reports a chain an update creates, and a clash with a live page', () => {
    const plan = planImport([rule('/new', '/old-target'), rule('/live', '/x')], [rule('/old-target', '/final')], {
      livePaths: ['/live'],
    });
    assert.deepEqual(
      plan.problems.map((p) => p.code),
      ['chain', 'clash'],
    );
  });

  it('keeps the existing note when the incoming rule has none, and treats a trailing slash as the same From', () => {
    const plan = planImport([rule('/change/', '/x')], existing);
    assert.equal(plan.rows[0].action, 'skip');
    assert.equal(plan.rows[0].reason, 'Already there.');
  });

  it('plans nothing for an empty file', () => {
    assert.deepEqual(planImport([], existing), { rows: [], adds: [], updates: [], problems: [] });
  });
});
