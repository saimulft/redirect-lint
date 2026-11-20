import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJson, toJson } from '../src/index.ts';

describe('parseJson', () => {
  it('reads an array of rules, defaulting the status to 301', () => {
    const { rules, problems } = parseJson(
      JSON.stringify([
        { from: '/a', to: '/b' },
        { from: '/c', to: '/d', status: '302', note: 'Moved', force: true },
        { from: '/g', status: 410 },
      ]),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(rules, [
      { index: 0, from: '/a', to: '/b', status: 301 },
      { index: 1, from: '/c', to: '/d', status: 302, note: 'Moved', force: true },
      { index: 2, from: '/g', to: null, status: 410 },
    ]);
  });

  it('reports unusable items with their index', () => {
    const { rules, problems } = parseJson(
      JSON.stringify([
        { from: '/ok', to: '/x' },
        'text',
        { from: 'bad', to: '/x' },
        { from: '/a', to: '/b', status: 404 },
        { from: '/off', to: '/x', enabled: false },
        { from: '/g', to: '/p', status: 410 },
      ]),
    );
    assert.deepEqual(
      rules.map((r) => r.from),
      ['/ok', '/g'],
    );
    assert.deepEqual(
      problems.map((p) => [p.index, p.code]),
      [
        [1, 'parse-error'],
        [2, 'invalid-from'],
        [3, 'invalid-status'],
        [4, 'disabled'],
        [5, 'gone-target'],
      ],
    );
  });

  it('reports a file that is not a JSON array', () => {
    assert.equal(parseJson('{').problems[0].code, 'parse-error');
    assert.match(parseJson('{').problems[0].message, /^Not valid JSON/);
    assert.equal(parseJson('{"from":"/a"}').problems[0].message, 'Expected a JSON array of redirect rules.');
    assert.deepEqual(parseJson('{').rules, []);
  });

  it('round-trips through toJson', () => {
    const rules = [
      { from: '/a', to: '/b', status: 301 },
      { from: '/c/*', to: '/d/*', status: 308, note: 'x', force: true },
      { from: '/g', to: null, status: 410 },
    ];
    const text = toJson(rules);
    assert.ok(text.endsWith('\n'));
    assert.equal(toJson(parseJson(text).rules), text);
  });
});
