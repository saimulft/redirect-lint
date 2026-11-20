import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRedirects, toRedirects } from '../src/index.ts';

describe('parseRedirects', () => {
  it('reads from, to and status, skipping comments and blank lines', () => {
    const text = [
      '# Moved pages',
      '',
      '/old  /new  301',
      '\t/tabs\t/here\t302',
      '/default /target',
      '   # indented comment',
    ].join('\n');
    const { rules, problems } = parseRedirects(text);
    assert.deepEqual(problems, []);
    assert.deepEqual(rules, [
      { line: 3, from: '/old', to: '/new', status: 301 },
      { line: 4, from: '/tabs', to: '/here', status: 302 },
      { line: 5, from: '/default', to: '/target', status: 301 },
    ]);
  });

  it('reads the force flag after the status', () => {
    const [rule] = parseRedirects('/a /b 301!').rules;
    assert.equal(rule.force, true);
    assert.equal(parseRedirects('/a /b 301').rules[0].force, undefined);
  });

  it('reads splats and placeholders, and turns :splat into a trailing wildcard', () => {
    const { rules, problems } = parseRedirects(
      '/blog/* /news/:splat 301\n/store/:id /shop/:id\n/docs/* https://docs.example.com/:splat 308',
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(
      rules.map((r) => [r.from, r.to, r.status]),
      [
        ['/blog/*', '/news/*', 301],
        ['/store/:id', '/shop/:id', 301],
        ['/docs/*', 'https://docs.example.com/*', 308],
      ],
    );
  });

  it('reads a 410 and drops its page', () => {
    const { rules, problems } = parseRedirects('/gone /gone.html 410');
    assert.deepEqual(problems, []);
    assert.deepEqual(rules, [{ line: 1, from: '/gone', to: null, status: 410 }]);
  });

  it('ends a rule at an inline comment, and handles CRLF and a BOM', () => {
    const { rules } = parseRedirects(`${String.fromCharCode(0xfeff)}/a /b 301 # why\r\n/c /d\r\n`);
    assert.deepEqual(
      rules.map((r) => [r.from, r.to]),
      [
        ['/a', '/b'],
        ['/c', '/d'],
      ],
    );
  });

  it('reports query matching as unsupported instead of guessing', () => {
    const { rules, problems } = parseRedirects('/store id=:id /blog/:id 301\n/search?q=1 /find\n/ok /fine');
    assert.deepEqual(
      rules.map((r) => r.from),
      ['/ok'],
    );
    assert.deepEqual(
      problems.map((p) => [p.line, p.code, p.severity]),
      [
        [1, 'unsupported', 'warning'],
        [2, 'unsupported', 'warning'],
      ],
    );
    assert.equal(problems[0].message, 'Query parameter matching (id=:id) is not supported.');
  });

  it('reports conditions and host-specific rules as unsupported', () => {
    const { rules, problems } = parseRedirects(
      [
        '/a /b 301 Country=us,ca',
        '/c /d 302! Language=en Role=admin',
        'https://old.example.com/* https://example.com/:splat 301!',
      ].join('\n'),
    );
    assert.deepEqual(rules, []);
    assert.deepEqual(
      problems.map((p) => p.code),
      ['unsupported', 'unsupported', 'unsupported'],
    );
    assert.equal(problems[0].message, 'Conditions (Country=us,ca) are not supported.');
    assert.match(problems[2].message, /host-specific/);
  });

  it('reports rewrites and other non-redirect statuses as unsupported', () => {
    const { rules, problems } = parseRedirects('/* /index.html 200\n/missing /404.html 404\n/ok /fine');
    assert.deepEqual(
      rules.map((r) => r.from),
      ['/ok'],
    );
    assert.match(problems[0].message, /200 rewrites/);
    assert.match(problems[1].message, /404 is not a redirect type/);
  });

  it('reports lines it cannot read as parse errors', () => {
    const { rules, problems } = parseRedirects('/only-from\n/a /b 301 nonsense\n/c /d 301 extra more');
    assert.deepEqual(rules, []);
    assert.deepEqual(
      problems.map((p) => [p.line, p.code, p.severity]),
      [
        [1, 'parse-error', 'error'],
        [2, 'parse-error', 'error'],
        [3, 'parse-error', 'error'],
      ],
    );
    assert.equal(problems[1].message, 'Unexpected "nonsense" after the status.');
  });

  it('reports invalid paths and targets with their line', () => {
    const { rules, problems } = parseRedirects('old /x\n/a b\n/c /d/:nope\n/e/* /f/*/g\n/h /i/*');
    assert.deepEqual(rules, []);
    assert.deepEqual(
      problems.map((p) => [p.line, p.code]),
      [
        [1, 'invalid-from'],
        [2, 'invalid-to'],
        [3, 'invalid-to'],
        [4, 'unsupported'],
        [5, 'invalid-to'],
      ],
    );
  });

  it('allows a status the options add', () => {
    assert.equal(parseRedirects('/a /b 404', { statuses: [404] }).rules[0].status, 404);
  });

  it('reads an empty file', () => {
    assert.deepEqual(parseRedirects(''), { rules: [], problems: [] });
  });
});

describe('toRedirects', () => {
  it('writes aligned columns, :splat targets and the force flag', () => {
    const text = toRedirects([
      { from: '/old', to: '/new', status: 301 },
      { from: '/blog/*', to: '/news/*', status: 302, force: true },
      { from: '/docs/*', to: 'https://docs.example.com/*', status: 308 },
    ]);
    assert.equal(
      text,
      [
        '/old     /new                             301',
        '/blog/*  /news/:splat                     302!',
        '/docs/*  https://docs.example.com/:splat  308',
        '',
      ].join('\n'),
    );
  });

  it('writes notes as comments, unless told not to', () => {
    const rules = [{ from: '/a', to: '/b', status: 301, note: 'Moved\nin May' }];
    assert.equal(toRedirects(rules), '# Moved in May\n/a  /b  301\n');
    assert.equal(toRedirects(rules, { notes: false }), '/a  /b  301\n');
  });

  it('gives a 410 a page, which the format needs', () => {
    assert.equal(toRedirects([{ from: '/g', to: null, status: 410 }]), '/g  /410.html  410\n');
    assert.equal(toRedirects([{ from: '/g', to: null, status: 410 }], { gonePage: '/gone' }), '/g  /gone  410\n');
  });

  it('writes nothing for no rules, and round-trips through parseRedirects', () => {
    assert.equal(toRedirects([]), '');
    const text = '/a      /b         301\n/p/:id  /q/:id     302!\n/w/*    /x/:splat  308\n';
    const { rules } = parseRedirects(text);
    assert.equal(toRedirects(rules), text);
  });
});
