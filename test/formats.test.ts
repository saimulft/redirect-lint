import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFormat, livePathsFromFiles, parse, serialize } from '../src/index.ts';

describe('detectFormat', () => {
  it('goes by the file name first', () => {
    assert.equal(detectFormat('', '_redirects'), 'redirects');
    assert.equal(detectFormat('', 'dist/_redirects'), 'redirects');
    assert.equal(detectFormat('', 'old.redirects'), 'redirects');
    assert.equal(detectFormat('[]', 'rules.csv'), 'csv');
    assert.equal(detectFormat('', 'rules.TSV'), 'csv');
    assert.equal(detectFormat('a,b', 'rules.json'), 'json');
  });

  it('falls back to the content', () => {
    assert.equal(detectFormat('  [{"from":"/a"}]'), 'json');
    assert.equal(detectFormat('# note\n/old /new 301\n'), 'redirects');
    assert.equal(detectFormat('from,to,status\n/a,/b,301'), 'csv');
    assert.equal(detectFormat('/a,/b'), 'csv');
    assert.equal(detectFormat('old\tnew'), 'csv');
    assert.equal(detectFormat(''), 'csv');
  });
});

describe('parse and serialize', () => {
  const rules = [{ from: '/a', to: '/b', status: 301 }];
  it('read and write each format', () => {
    for (const format of ['csv', 'redirects', 'json'] as const) {
      const back = parse(serialize(rules, format), format).rules;
      assert.deepEqual(
        back.map(({ from, to, status }) => ({ from, to, status })),
        rules,
        format,
      );
    }
  });

  it('convert a WordPress CSV to a _redirects file', () => {
    const csv = 'source,target,regex,code\n/old/,/new/,0,301\n/blog/*,/news/*,0,302\n';
    assert.equal(
      serialize(parse(csv, 'csv').rules, 'redirects'),
      '/old/    /new/         301\n/blog/*  /news/:splat  302\n',
    );
  });
});

describe('livePathsFromFiles', () => {
  it('maps html files to their pages, and index.html to its folder', () => {
    assert.deepEqual(
      livePathsFromFiles([
        'index.html',
        'blog/index.html',
        'about.html',
        'docs/guide/setup.html',
        'logo.png',
        'app.js',
      ]),
      [
        '/',
        '/about',
        '/about.html',
        '/blog',
        '/blog/index.html',
        '/docs/guide/setup',
        '/docs/guide/setup.html',
        '/index.html',
      ],
    );
  });

  it('accepts Windows separators and a leading ./', () => {
    assert.deepEqual(livePathsFromFiles(['.\\blog\\index.html', './a.html']), [
      '/a',
      '/a.html',
      '/blog',
      '/blog/index.html',
    ]);
  });

  it('returns nothing when there are no pages', () => {
    assert.deepEqual(livePathsFromFiles(['style.css']), []);
  });
});
