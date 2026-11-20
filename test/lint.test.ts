import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lint } from '../src/index.ts';
import { rule } from './helpers.ts';

const codes = (rules: Parameters<typeof lint>[0], options?: Parameters<typeof lint>[1]) =>
  lint(rules, options).map((p) => `${p.code}:${p.from}`);

describe('lint: chains', () => {
  it('reports a chain once, from its first rule, with the whole path', () => {
    const problems = lint([rule('/old-pricing', '/pricing-2025'), rule('/pricing-2025', '/pricing')]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'chain');
    assert.equal(problems[0].severity, 'warning');
    assert.equal(problems[0].from, '/old-pricing');
    assert.equal(problems[0].index, 0);
    assert.deepEqual(problems[0].related, [{ index: 1 }]);
    assert.equal(problems[0].message, '/old-pricing → /pricing-2025 → /pricing. Served as /old-pricing → /pricing.');
  });

  it('follows wildcards and placeholders through a chain', () => {
    const wild = lint([rule('/blog/*', '/news/*'), rule('/news/*', '/articles/*', 308)]);
    assert.equal(wild.length, 1);
    assert.match(wild[0].message, /Served as \/blog\/\* → \/articles\/\*\./);
    const exact = lint([rule('/old/post', '/blog/post'), rule('/blog/*', '/news/*')]);
    assert.match(exact[0].message, /Served as \/old\/post → \/news\/post\./);
    const params = lint([rule('/store/:id', '/shop/:id'), rule('/shop/:sku', '/catalog/:sku')]);
    assert.match(params[0].message, /Served as \/store\/:id → \/catalog\/:id\./);
  });

  it('reports a chain into a 410 as a 410', () => {
    const problems = lint([rule('/x', '/beta'), rule('/beta', null, 410)]);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /Served as a 410 for \/x\./);
  });

  it('does not follow external targets', () => {
    assert.deepEqual(lint([rule('/a', 'https://example.com/b'), rule('/b', '/c')]), []);
  });
});

describe('lint: loops', () => {
  it('reports a loop once, with what leads into it', () => {
    const problems = lint([rule('/a', '/b'), rule('/b', '/a'), rule('/c', '/a'), rule('/d', '/e')]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'loop');
    assert.equal(problems[0].severity, 'error');
    assert.equal(problems[0].from, '/a');
    assert.match(problems[0].message, /^\/a → \/b → \/a is a loop, so none of them is served\./);
    assert.match(problems[0].message, /\/c leads into it and is left out too\./);
    assert.deepEqual(problems[0].related, [{ index: 1 }, { index: 2 }]);
  });

  it('catches a redirect to itself, with or without a trailing slash', () => {
    assert.deepEqual(codes([rule('/s', '/s/')]), ['loop:/s']);
    assert.match(lint([rule('/s', '/s')])[0].message, /it isn't served/);
  });

  it('catches a wildcard whose target it matches again, but not its own index', () => {
    assert.deepEqual(codes([rule('/blog/*', '/blog/new/*')]), ['loop:/blog/*']);
    assert.deepEqual(codes([rule('/blog/*', '/blog')]), []);
  });

  it('catches a loop through placeholders', () => {
    assert.deepEqual(codes([rule('/a/:id', '/b/:id'), rule('/b/:x', '/a/:x')]), ['loop:/a/:id']);
  });

  it('treats a chain longer than maxHops as a loop', () => {
    const rules = [rule('/1', '/2'), rule('/2', '/3'), rule('/3', '/4'), rule('/4', '/5')];
    assert.deepEqual(
      codes(rules, { maxHops: 3 }).filter((c) => c.startsWith('loop')),
      ['loop:/1'],
    );
    const long = lint(rules, { maxHops: 3 }).find((p) => p.code === 'loop');
    assert.match(long?.message ?? '', /passes through more than 3 redirects/);
    assert.deepEqual(
      codes(rules).filter((c) => c.startsWith('loop')),
      [],
    );
  });
});

describe('lint: rules that are wrong', () => {
  it('reports malformed paths, targets and statuses as errors and leaves them out', () => {
    const problems = lint([
      rule('old', '/x'),
      rule('/a b', '/x'),
      rule('/one', '/two/*'),
      rule('/three', ''),
      rule('https://example.com/a', '/x'),
      rule('/four', 'x'),
      rule('/five', '/x', 404),
      rule('/six', '/x/:missing'),
      rule('/seven/:id/:id', '/x'),
    ]);
    assert.deepEqual(
      problems.map((p) => [p.code, p.severity, p.index]),
      [
        ['invalid-from', 'error', 0],
        ['invalid-from', 'error', 1],
        ['invalid-to', 'error', 2],
        ['invalid-to', 'error', 3],
        ['invalid-from', 'error', 4],
        ['invalid-to', 'error', 5],
        ['invalid-status', 'error', 6],
        ['invalid-to', 'error', 7],
        ['invalid-from', 'error', 8],
      ],
    );
    assert.equal(problems[0].message, 'Start the path with /.');
    assert.equal(problems[2].message, 'A * in the target needs a wildcard From, such as /blog/*.');
    assert.equal(problems[6].message, "404 isn't a redirect type. Use 301, 302, 303, 307, 308 or 410.");
    assert.equal(problems[7].message, "The target uses :missing, which the From doesn't define.");
  });

  it('reports wildcards that are not at the end as unsupported', () => {
    const [middle, glued, target] = lint([rule('/a/*/b', '/x'), rule('/blog*', '/x'), rule('/c/*', '/x/*/y')]);
    assert.equal(middle.code, 'unsupported');
    assert.equal(middle.severity, 'warning');
    assert.equal(glued.code, 'unsupported');
    assert.equal(target.code, 'unsupported');
  });

  it('applies the length limits and the status list from the options', () => {
    assert.equal(
      lint([rule(`/${'a'.repeat(10)}`, '/x')], { maxFromLength: 5 })[0].message,
      'Keep the path under 5 characters.',
    );
    assert.equal(
      lint([rule('/a', `/${'b'.repeat(10)}`)], { maxToLength: 5 })[0].message,
      'Keep the target under 5 characters.',
    );
    assert.deepEqual(codes([rule('/a', '/b', 302)], { statuses: [301] }), ['invalid-status:/a']);
    assert.deepEqual(codes([rule('/a', '/b', 404)], { statuses: [301, 404] }), []);
  });

  it('notes that a 410 ignores its target', () => {
    const [p] = lint([rule('/g', '/ignored', 410)]);
    assert.equal(p.code, 'gone-target');
    assert.equal(p.severity, 'info');
    assert.deepEqual(lint([rule('/g', null, 410)]), []);
  });
});

describe('lint: duplicates and shadowed rules', () => {
  it('reports duplicate Froms, treating a trailing slash as the same path', () => {
    const [p] = lint([rule('/dup', '/x'), rule('/dup/', '/y'), rule('/other', '/z')]);
    assert.equal(p.code, 'duplicate');
    assert.equal(p.message, '/dup and /dup/ are the same path, so only /dup is used.');
    assert.deepEqual(p.related, [{ index: 1 }]);
    assert.match(lint([rule('/dup', '/x'), rule('/dup', '/y')])[0].message, /^2 redirects start from \/dup/);
  });

  it('treats placeholders with different names as the same From', () => {
    assert.deepEqual(codes([rule('/p/:a', '/x'), rule('/p/:b', '/y')]), ['duplicate:/p/:a']);
  });

  it('reports a rule that an earlier, broader one always matches first', () => {
    const [p] = lint([rule('/blog/*', '/news/*'), rule('/blog/special', '/x')]);
    assert.equal(p.code, 'shadowed');
    assert.equal(p.from, '/blog/special');
    assert.match(p.message, /never reached: \/blog\/\* \(index 0\)/);
    // The other order is fine: the specific rule comes first.
    assert.deepEqual(codes([rule('/blog/special', '/x'), rule('/blog/*', '/news/*')]), []);
    // A placeholder doesn't hide a rule it only partly overlaps.
    assert.deepEqual(codes([rule('/a/:id', '/x'), rule('/a/:id/edit', '/y')]), []);
  });
});

describe('lint: live pages', () => {
  it('reports clashes with live pages, ignoring trailing slashes', () => {
    const problems = lint([rule('/pricing', '/plans'), rule('/docs/*', '/help/*'), rule('/gone', '/x')], {
      livePaths: ['/pricing/', '/docs/install', '/docs/billing', '/docs'],
    });
    assert.deepEqual(
      problems.map((p) => [p.code, p.from]),
      [
        ['clash', '/pricing'],
        ['clash', '/docs/*'],
      ],
    );
    assert.equal(
      problems[0].message,
      '/pricing is a live page. The redirect hides it on hosts that apply redirects first.',
    );
    assert.equal(problems[1].message, '/docs/* covers 2 live pages, such as /docs/billing.');
  });

  it('names the single page a wildcard covers, and covers placeholders too', () => {
    const [wild, param] = lint([rule('/docs/*', '/x/*'), rule('/shop/:id', '/y')], {
      livePaths: ['/docs/a', '/shop/one'],
    });
    assert.equal(wild.message, '/docs/* covers the live page /docs/a.');
    assert.equal(param.message, '/shop/:id covers the live page /shop/one.');
  });

  it('says so when a forced redirect makes a page unreachable', () => {
    const [p] = lint([{ ...rule('/page', '/other'), force: true }], { livePaths: ['/page'] });
    assert.match(p.message, /forced/);
  });

  it('accepts live paths without a leading slash and any iterable', () => {
    assert.deepEqual(codes([rule('/page', '/x')], { livePaths: new Set(['page']) }), ['clash:/page']);
  });

  it('reports nothing without livePaths', () => {
    assert.deepEqual(lint([rule('/page', '/x')]), []);
  });
});

describe('lint: where problems point', () => {
  it('uses a rule own line or index when it has one, else its position', () => {
    const problems = lint([
      { ...rule('/a', '/b'), line: 7 },
      { ...rule('/b', '/a'), line: 9 },
    ]);
    assert.equal(problems[0].line, 7);
    assert.equal(problems[0].index, undefined);
    assert.deepEqual(problems[0].related, [{ line: 9 }]);
  });

  it('sorts problems by position', () => {
    const problems = lint([rule('/x', 'bad'), rule('/dup', '/a'), rule('/dup', '/b'), rule('/y', '')]);
    assert.deepEqual(
      problems.map((p) => p.index),
      [0, 1, 3],
    );
  });
});
