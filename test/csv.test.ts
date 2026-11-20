import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv, toCsv } from '../src/index.ts';
import { splitCsv } from '../src/csv.ts';

const BOM = String.fromCharCode(0xfeff);

describe('splitCsv', () => {
  it('parses quotes, CRLF, a BOM and semicolons', () => {
    assert.deepEqual(
      splitCsv(`${BOM}from,to\r\n"/a,b","/say ""hi"""\r\n`).map((r) => r.cells),
      [
        ['from', 'to'],
        ['/a,b', '/say "hi"'],
      ],
    );
    assert.deepEqual(
      splitCsv('/a;/b;302\n/c;/d').map((r) => r.cells),
      [
        ['/a', '/b', '302'],
        ['/c', '/d'],
      ],
    );
    assert.deepEqual(
      splitCsv('/a\t/b\n').map((r) => r.cells),
      [['/a', '/b']],
    );
  });

  it('tracks the line each row starts on, including quoted line breaks', () => {
    const rows = splitCsv('a,b\n"x\ny",z\n\nlast,row');
    assert.deepEqual(
      rows.map((r) => r.line),
      [1, 2, 4, 5],
    );
  });
});

describe('parseCsv', () => {
  it('reads a WordPress Redirection export', () => {
    const csv = [
      'source,target,regex,code,type,hits,title,status',
      '/old-page/,/new-page/,0,301,url,12,Old page,enabled',
      'https://example.com/gone,,0,410,url,0,,enabled',
      '/^blog/(.*)$,/news/$1,1,301,url,0,,enabled',
      '/off,/on,0,302,url,0,,disabled',
      '/notfound,/x,0,404,url,0,,enabled',
    ].join('\n');
    const { rules, problems } = parseCsv(csv);
    assert.deepEqual(rules, [
      { line: 2, from: '/old-page/', to: '/new-page/', status: 301, note: 'Old page' },
      { line: 3, from: '/gone', to: null, status: 410, note: '' },
    ]);
    assert.deepEqual(
      problems.map((p) => [p.line, p.code, p.severity, p.message]),
      [
        [4, 'unsupported', 'warning', "Regex redirects aren't supported. Add it as a wildcard, such as /blog/*."],
        [5, 'disabled', 'info', 'Turned off in the file.'],
        [6, 'invalid-status', 'error', "404 isn't a redirect type. Use 301, 302, 303, 307, 308 or 410."],
      ],
    );
  });

  it('reads headerless rows: from, to, status, note', () => {
    const { rules, problems } = parseCsv('/a,/b,302,Moved\n/c,/d\nno-slash,x,301');
    assert.deepEqual(problems, []);
    assert.deepEqual(rules, [
      { line: 1, from: '/a', to: '/b', status: 302, note: 'Moved' },
      { line: 2, from: '/c', to: '/d', status: 301, note: '' },
      { line: 3, from: '/no-slash', to: '/x', status: 301, note: '' },
    ]);
  });

  it('recognises common header names and turns full addresses into paths', () => {
    const { rules } = parseCsv('Old URL,New URL,HTTP Code\nhttps://example.com/old?x=1,https://example.com/new,308\n');
    assert.deepEqual(rules, [{ line: 2, from: '/old?x=1', to: 'https://example.com/new', status: 308, note: '' }]);
  });

  it('reads a status column that holds the code, and skips rows turned off by enabled or active', () => {
    const { rules, problems } = parseCsv('from,to,status,enabled\n/a,/b,302,yes\n/c,/d,301,0\n');
    assert.deepEqual(
      rules.map((r) => [r.from, r.status]),
      [['/a', 302]],
    );
    assert.deepEqual(
      problems.map((p) => p.code),
      ['disabled'],
    );
  });

  it('reports bad paths and targets with their line, and leaves those rows out', () => {
    const { rules, problems } = parseCsv('/ok,/x\n/blog*,/x\n/two words,/x\n/no-target,\n/a,/b c\n');
    assert.deepEqual(
      rules.map((r) => r.from),
      ['/ok'],
    );
    assert.deepEqual(
      problems.map((p) => [p.line, p.code]),
      [
        [2, 'unsupported'],
        [3, 'invalid-from'],
        [4, 'invalid-to'],
        [5, 'invalid-to'],
      ],
    );
  });

  it('notes a 410 whose target is ignored, and keeps the rule', () => {
    const { rules, problems } = parseCsv('/gone,/somewhere,410');
    assert.deepEqual(rules, [{ line: 1, from: '/gone', to: null, status: 410, note: '' }]);
    assert.equal(problems[0].code, 'gone-target');
  });

  it('turns :splat into a wildcard target', () => {
    assert.equal(parseCsv('/blog/*,/news/:splat').rules[0].to, '/news/*');
  });

  it('limits the note length and the number of rows from the options', () => {
    assert.equal(parseCsv('/a,/b,301,abcdefghij', { maxNoteLength: 4 }).rules[0].note, 'abcd');
    const tooMany = parseCsv('/a,/b\n/c,/d\n/e,/f', { maxRows: 2 });
    assert.deepEqual(tooMany.rules, []);
    assert.equal(tooMany.problems[0].code, 'parse-error');
    assert.equal(tooMany.problems[0].message, 'That file has 3 rows. Import up to 2 at a time.');
    assert.equal(parseCsv('/a,/b\n/c,/d', { maxRows: 2 }).rules.length, 2);
  });

  it('returns nothing for an empty file', () => {
    assert.deepEqual(parseCsv(''), { rules: [], problems: [] });
  });
});

describe('toCsv', () => {
  it('writes a header and quotes what needs it', () => {
    assert.equal(
      toCsv([
        { from: '/a', to: '/b', status: 301 },
        { from: '/g', to: null, status: 410, note: 'Said "gone", for good' },
      ]),
      'from,to,status,note\n/a,/b,301,\n/g,,410,"Said ""gone"", for good"\n',
    );
  });

  it('round-trips through parseCsv', () => {
    const rules = [
      { from: '/a', to: '/b', status: 302, note: 'one, two' },
      { from: '/blog/*', to: '/news/*', status: 301, note: '' },
    ];
    const back = parseCsv(toCsv(rules)).rules.map(({ from, to, status, note }) => ({ from, to, status, note }));
    assert.deepEqual(back, rules);
  });
});
