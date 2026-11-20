import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flatten } from '../src/index.ts';
import { rule } from './helpers.ts';

const froms = (rules: { from: string }[]) => rules.map((r) => r.from);

describe('flatten', () => {
  it('collapses chains to the final target', () => {
    const { rules, counts } = flatten([rule('/old-pricing', '/pricing-2025'), rule('/pricing-2025', '/pricing')]);
    assert.deepEqual(rules, [
      { from: '/old-pricing', to: '/pricing', status: 301 },
      { from: '/pricing-2025', to: '/pricing', status: 301 },
    ]);
    assert.deepEqual(counts, { input: 2, output: 2, collapsed: 1, dropped: 0 });
  });

  it('keeps the status of the first rule in a chain', () => {
    const { rules } = flatten([rule('/a', '/b', 302), rule('/b', '/c', 308)]);
    assert.deepEqual(
      rules.map((r) => [r.from, r.to, r.status]),
      [
        ['/a', '/c', 302],
        ['/b', '/c', 308],
      ],
    );
  });

  it('keeps the rest of the path through wildcards and collapses wildcard chains', () => {
    assert.deepEqual(flatten([rule('/blog/*', '/news/*')]).rules, [{ from: '/blog/*', to: '/news/*', status: 301 }]);
    const two = flatten([rule('/blog/*', '/news/*'), rule('/news/*', '/articles/*', 308)]).rules;
    assert.equal(two.find((r) => r.from === '/blog/*')?.to, '/articles/*');
    const three = flatten([rule('/old/post', '/blog/post'), rule('/blog/*', '/news/*')]).rules;
    assert.equal(three.find((r) => r.from === '/old/post')?.to, '/news/post');
  });

  it('carries placeholders through a chain', () => {
    const { rules } = flatten([rule('/store/:id', '/shop/:id'), rule('/shop/:sku', '/catalog/:sku/view')]);
    assert.equal(rules.find((r) => r.from === '/store/:id')?.to, '/catalog/:id/view');
  });

  it('orders exact paths, then placeholders, then wildcards, longest first', () => {
    const { rules } = flatten([
      rule('/a/*', 'https://example.com/1'),
      rule('/a/b/*', 'https://example.com/2'),
      rule('/z', 'https://example.com/3'),
      rule('/p/:id', 'https://example.com/4'),
      rule('/*', 'https://example.com/5'),
    ]);
    assert.deepEqual(froms(rules), ['/z', '/p/:id', '/a/b/*', '/a/*', '/*']);
  });

  it('leaves loops out, with what leads into them', () => {
    const { rules, counts, problems } = flatten([
      rule('/a', '/b'),
      rule('/b', '/a'),
      rule('/c', '/a'),
      rule('/d', '/e'),
    ]);
    assert.deepEqual(froms(rules), ['/d']);
    assert.equal(counts.dropped, 3);
    assert.equal(problems.filter((p) => p.code === 'loop').length, 1);
  });

  it('serves a 410 without a target, and a chain into a 410 as a 410', () => {
    const { rules } = flatten([rule('/beta', '/ignored', 410), rule('/x', '/beta')]);
    assert.deepEqual(rules, [
      { from: '/beta', to: null, status: 410 },
      { from: '/x', to: null, status: 410 },
    ]);
  });

  it('drops malformed rules and repeated Froms, keeping the first', () => {
    const { rules, problems } = flatten([
      rule('/dup', '/x'),
      rule('/dup/', '/y'),
      rule('bad', '/x'),
      rule('/ok', '/z'),
    ]);
    assert.deepEqual(
      rules.map((r) => [r.from, r.to]),
      [
        ['/dup', '/x'],
        ['/ok', '/z'],
      ],
    );
    assert.deepEqual(
      problems.map((p) => p.code),
      ['duplicate', 'invalid-from'],
    );
  });

  it('keeps clashing rules and reports them', () => {
    const { rules, problems } = flatten([rule('/pricing', '/plans')], { livePaths: ['/pricing'] });
    assert.deepEqual(froms(rules), ['/pricing']);
    assert.deepEqual(
      problems.map((p) => p.code),
      ['clash'],
    );
  });

  it('keeps notes, force and where each rule came from', () => {
    const { rules } = flatten([{ ...rule('/a', '/b'), note: 'Moved', force: true, line: 4 }]);
    assert.deepEqual(rules, [{ from: '/a', to: '/b', status: 301, note: 'Moved', force: true, line: 4 }]);
  });

  it('accepts :splat as the end of a wildcard target', () => {
    assert.equal(flatten([rule('/blog/*', '/news/:splat')]).rules[0].to, '/news/*');
  });

  it('flattens an already flat set to itself', () => {
    const input = [rule('/a', '/x'), rule('/b', '/y'), rule('/c/*', '/z/*')];
    const once = flatten(input).rules;
    assert.deepEqual(flatten(once).rules, once);
  });
});
