import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'redirect-lint-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const CLEAN = '/old /new 301\n/blog/* /news/:splat 301\n';
const BROKEN = ['# redirects', '/a /b', '/b /a', '/chain /old 301', '/old /new 301', '/q id=:id /x', ''].join('\n');

describe('cli', () => {
  it('exits 0 and says so when there is nothing to report', () => {
    const r = run(file('clean/_redirects', CLEAN));
    assert.equal(r.code, 0);
    assert.match(r.out, /No problems found in 2 rules\./);
    assert.match(r.out, /\(redirects, 2 rules\)/);
  });

  it('prints problems grouped by severity and exits 1 on errors', () => {
    const r = run(file('broken/_redirects', BROKEN));
    assert.equal(r.code, 1);
    assert.match(r.out, /Errors \(1\)\n {2}line 2 {2}loop {2}\/a → \/b → \/a is a loop/);
    assert.match(r.out, /Warnings \(2\)/);
    assert.match(r.out, /chain/);
    assert.match(r.out, /unsupported/);
    assert.ok(r.out.indexOf('Errors') < r.out.indexOf('Warnings'));
    assert.match(r.out, /1 error, 2 warnings in 4 rules\./);
  });

  it('exits 0 for warnings alone', () => {
    const r = run(file('warn/_redirects', '/a /b\n/b /c\n'));
    assert.equal(r.code, 0);
    assert.match(r.out, /0 errors, 1 warning in 2 rules\./);
  });

  it('prints JSON with --json', () => {
    const r = run(file('json/_redirects', BROKEN), '--json');
    assert.equal(r.code, 1);
    const data = JSON.parse(r.out);
    assert.equal(data.format, 'redirects');
    assert.equal(data.rules, 4);
    assert.deepEqual(data.summary, { errors: 1, warnings: 2, info: 0 });
    assert.deepEqual(
      data.problems.map((p: { code: string; severity: string; line: number }) => [p.line, p.code, p.severity]),
      [
        [2, 'loop', 'error'],
        [4, 'chain', 'warning'],
        [6, 'unsupported', 'warning'],
      ],
    );
  });

  it('detects csv and json by name and content, and takes --format', () => {
    assert.match(run(file('rules.csv', 'from,to,status\n/a,/b,301\n')).out, /\(csv, 1 rule\)/);
    assert.match(run(file('rules.json', '[{"from":"/a","to":"/b"}]')).out, /\(json, 1 rule\)/);
    assert.match(run(file('noext', '/a /b 301\n')).out, /\(redirects, 1 rule\)/);
    assert.match(run(file('noext-csv', '/a,/b\n')).out, /\(csv, 1 rule\)/);
    assert.match(run(file('forced.txt', '/a,/b\n'), '--format', 'csv').out, /\(csv, 1 rule\)/);
    assert.match(run(file('forced2.txt', '/a /b\n'), '-f', 'redirects').out, /\(redirects, 1 rule\)/);
  });

  it('reports redirects that shadow built pages with --pages', () => {
    const site = join(dir, 'site');
    file('site/index.html', '<html></html>');
    file('site/about.html', '<html></html>');
    file('site/blog/index.html', '<html></html>');
    file('site/blog/post.html', '<html></html>');
    file('site/logo.png', 'x');
    const r = run(
      file('pages/_redirects', '/about /company\n/blog/* /news/:splat\n/fine /elsewhere\n'),
      '--pages',
      site,
    );
    assert.equal(r.code, 0);
    assert.match(r.out, /clash {2}\/about is a live page\./);
    assert.match(r.out, /clash {2}\/blog\/\* covers 3 live pages, such as \/blog\/index\.html\./);
    assert.doesNotMatch(r.out, /\/fine/);
  });

  it('prints the flattened rules with --flatten, sending the report to stderr', () => {
    const r = run(file('flat/_redirects', '/a /b\n/b /c\n/blog/* /news/:splat\n'), '--flatten');
    assert.equal(r.code, 0);
    assert.equal(r.out, '/a       /c            301\n/b       /c            301\n/blog/*  /news/:splat  301\n');
    assert.match(r.err, /1 warning/);
  });

  it('writes the flattened rules with --out, converting by the file name', () => {
    const input = file('conv/rules.csv', 'from,to,status\n/a,/b,301\n/b,/c,301\n/loop,/loop,301\n');
    const out = join(dir, 'conv', '_redirects');
    const r = run(input, '--flatten', '--out', out);
    assert.equal(r.code, 1);
    assert.match(r.out, /Wrote 2 rules to /);
    assert.match(r.out, /1 rule left out of the flattened rules/);
    assert.equal(readFileSync(out, 'utf8'), '/a  /c  301\n/b  /c  301\n');
    const json = join(dir, 'conv', 'flat.json');
    run(input, '--flatten', '--out', json);
    assert.deepEqual(
      JSON.parse(readFileSync(json, 'utf8')).map((r: { from: string }) => r.from),
      ['/a', '/b'],
    );
  });

  it('includes the flattened rules in --json output', () => {
    const data = JSON.parse(run(file('flatjson/_redirects', '/a /b\n/b /c\n'), '--flatten', '--json').out);
    assert.deepEqual(
      data.flattened.map((r: { from: string; to: string }) => [r.from, r.to]),
      [
        ['/a', '/c'],
        ['/b', '/c'],
      ],
    );
  });

  it('reports a file that is not valid JSON as an error in the file', () => {
    const r = run(file('bad.json', '{'));
    assert.equal(r.code, 1);
    assert.match(r.out, /parse-error/);
  });

  it('applies --max-rows to CSV', () => {
    const r = run(file('rows.csv', '/a,/b\n/c,/d\n/e,/f\n'), '--max-rows', '2');
    assert.equal(r.code, 1);
    assert.match(r.out, /That file has 3 rows\. Import up to 2 at a time\./);
  });

  it('prints help and the version', () => {
    const help = run('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage\n {2}redirect-lint <file>/);
    const version = run('--version');
    assert.equal(version.code, 0);
    assert.equal(
      version.out.trim(),
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
  });

  it('exits 2 on usage errors', () => {
    const cases: [string[], RegExp][] = [
      [[], /Pass the file to check/],
      [['a', 'b'], /Pass one file/],
      [['--nope', 'x'], /Unknown option/],
      [[file('u.txt', ''), '--format', 'xml'], /Unknown format "xml"/],
      [[join(dir, 'missing.csv')], /Can't read .*missing\.csv: ENOENT/],
      [[file('u2.csv', ''), '--out', 'x'], /--out needs --flatten/],
      [[file('u3.csv', ''), '--pages', join(dir, 'nowhere')], /Can't read the folder/],
      [[file('u4.csv', ''), '--max-rows', 'many'], /--max-rows needs a whole number/],
    ];
    for (const [args, message] of cases) {
      const r = run(...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err, message);
      assert.equal(r.out, '');
    }
  });
});
