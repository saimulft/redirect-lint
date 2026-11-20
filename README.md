# redirect-lint

Validate and flatten redirect rules before you ship them.

[![npm version](https://img.shields.io/npm/v/redirect-lint)](https://www.npmjs.com/package/redirect-lint)
[![license](https://img.shields.io/npm/l/redirect-lint)](https://www.npmjs.com/package/redirect-lint)
[![node version](https://img.shields.io/node/v/redirect-lint)](https://www.npmjs.com/package/redirect-lint)

Extracted from [Sitessa](https://sitessa.com), a headless CMS, where it validates redirect rules and CSV imports.

redirect-lint reads a redirect list (a Netlify or Cloudflare Pages `_redirects` file, a CSV including a WordPress Redirection export, or a JSON array) and checks the whole set: loops, chains, duplicates, rules that an earlier rule hides, and redirects that shadow pages you actually have. It can also collapse chains into one hop and write the result back out in any of the three formats. Netlify's `@netlify/redirect-parser` parses rules but doesn't check a rule set for loops, chains or clashes; that is the part this package does. It has no dependencies.

## Install

```sh
npm install redirect-lint
```

Or run it without installing:

```sh
npx redirect-lint _redirects
```

Node 20 or newer.

## CLI

```
redirect-lint <file> [--format csv|redirects|json] [--pages <dir>] [--flatten [--out <file>]] [--json]
```

| Option                | What it does                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `-f, --format <type>` | `csv`, `redirects` or `json`. Default: from the file name (`_redirects`, `.csv`, `.json`), then content. |
| `--pages <dir>`       | A built site folder. Each `.html` file is a live page; redirects that hide one are reported.             |
| `--flatten`           | Collapse chains and print the final rules in the file's format. The report goes to stderr.               |
| `--out <file>`        | With `--flatten`, write the rules to a file. A `.csv`, `.json` or `_redirects` name sets the format.     |
| `--max-rows <n>`      | Most rows a CSV file may have. Default: 5000.                                                            |
| `--json`              | Print the result as JSON instead of text.                                                                |

Exit codes: `0` when there are no errors (warnings and notes don't fail the run), `1` when the rules have errors, `2` for a usage error or a file that can't be read.

Given this `_redirects` file and a built site in `dist/`:

```
# Marketing site
/pricing-old   /pricing-2025     301
/pricing-2025  /pricing          301
/blog/*        /articles/:splat  301
/blog/hello    /articles/welcome 301
/team          /about/team       301
/about/team    /team             301
/docs/v1/*     /docs/:splat      308
/legacy        /410.html         410
/search?q=shoes /shop            301
/contact       /contact-us       302
/api/*         /index.html       200
/old-contact   /contact          301
```

```sh
npx redirect-lint _redirects --pages dist
```

```
_redirects (redirects, 10 rules)

Errors (1)
  line 6  loop  /team → /about/team → /team is a loop, so none of them is served.

Warnings (8)
  line 2   chain        /pricing-old → /pricing-2025 → /pricing. Served as /pricing-old → /pricing.
  line 4   clash        /blog/* covers 3 live pages, such as /blog/hello.
  line 5   shadowed     /blog/hello is never reached: /blog/* (line 4) matches the same paths first on hosts that use the first match.
  line 5   clash        /blog/hello is a live page. The redirect hides it on hosts that apply redirects first.
  line 10  unsupported  /search?q=shoes: Query strings in the From are not supported. Matching on query parameters needs the host.
  line 11  clash        /contact is a live page. The redirect hides it on hosts that apply redirects first.
  line 12  unsupported  /api/*: 200 rewrites and proxies are not redirects, so they are not checked.
  line 13  chain        /old-contact → /contact → /contact-us. Served as /old-contact → /contact-us.

1 error, 8 warnings in 10 rules.
```

Add `--flatten --out` to write the cleaned-up rules. Chains become one hop, the loop is left out, and the most specific rules come first, which is the order hosts that take the first match need:

```sh
npx redirect-lint _redirects --flatten --out dist/_redirects
```

```
/blog/hello    /articles/welcome  301
/contact       /contact-us        302
/legacy        /410.html          410
/old-contact   /contact-us        301
/pricing-2025  /pricing           301
/pricing-old   /pricing           301
/docs/v1/*     /docs/:splat       308
/blog/*        /articles/:splat   301
```

The two rules it could not read (`/search?q=shoes` and `/api/*`) and the two in the loop are not in that file. The command says so, and it still exits `1` because of the loop. Because `--out` picks the format from the file name, `redirect-lint wordpress-export.csv --flatten --out _redirects` also converts a WordPress Redirection export.

## API

```ts
import { parseRedirects, lint, flatten, toRedirects } from 'redirect-lint';

const { rules, problems: parseProblems } = parseRedirects(text);
const problems = lint(rules, { livePaths: ['/about', '/blog/hello'] });

const { rules: flat } = flatten(rules);
await writeFile('_redirects', toRedirects(flat));
```

A rule is `{ from, to, status, note?, force? }`. `to` is `null` for a 410. A trailing `/*` in `from` is a wildcard and a trailing `/*` in `to` puts the rest of the path there (`/blog/*` to `/news/*`); `:id` matches one path segment and `:id` in `to` puts it back. Rules that came from a file also carry `line` (CSV and `_redirects`, 1-based) or `index` (JSON, 0-based).

A problem is `{ code, severity, message, from?, line?, index?, related? }`. `severity` is `'error'`, `'warning'` or `'info'`. `related` lists the other rules involved, such as the rest of a chain.

### Reading

| Export                           | Returns                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseRedirects(text, options?)` | `{ rules, problems }` from a `_redirects` file. Query matching, conditions and rewrites are reported as `unsupported`.                      |
| `parseCsv(text, options?)`       | `{ rules, problems }` from CSV: `from,to,status[,note]`, with or without a header, `;` or tab delimited, or a WordPress Redirection export. |
| `parseJson(text, options?)`      | `{ rules, problems }` from a JSON array of `{ from, to, status?, note?, force?, enabled? }`.                                                |
| `parse(text, format, options?)`  | The same, for `'csv'`, `'redirects'` or `'json'`.                                                                                           |
| `detectFormat(text, fileName?)`  | `'csv'`, `'redirects'` or `'json'`, from the name and then the content.                                                                     |

Rows that can't be used are left out of `rules` and explained in `problems`, so a bad row never stops the rest being checked.

Parse options (`ParseOptions`):

| Option          | Default                   | Meaning                                         |
| --------------- | ------------------------- | ----------------------------------------------- |
| `statuses`      | `301 302 303 307 308 410` | Statuses a rule may have.                       |
| `maxFromLength` | `500`                     | Longest From, in characters.                    |
| `maxToLength`   | `1000`                    | Longest target, in characters.                  |
| `maxNoteLength` | `500`                     | Longest note kept (CSV and JSON).               |
| `maxRows`       | `5000`                    | Most rows in a CSV file. More is a parse error. |

### Checking

```ts
lint(rules, options?): Problem[]
```

Checks a rule set and returns every problem, ordered by position. Options (`LintOptions`):

| Option                         | Default                   | Meaning                                                        |
| ------------------------------ | ------------------------- | -------------------------------------------------------------- |
| `livePaths`                    | none                      | Paths of live pages, to find redirects that shadow them.       |
| `statuses`                     | `301 302 303 307 308 410` | Statuses a rule may have.                                      |
| `maxHops`                      | `20`                      | Redirects a chain may pass through before it counts as a loop. |
| `maxFromLength`, `maxToLength` | `500`, `1000`             | Longest From and target.                                       |

```ts
lint([
  { from: '/a', to: '/b', status: 301 },
  { from: '/b', to: '/a', status: 301 },
]);
// [{ code: 'loop', severity: 'error', message: '/a → /b → /a is a loop, so none of them is served.', from: '/a', index: 0, related: [{ index: 1 }] }]
```

```ts
livePathsFromFiles(files: Iterable<string>): string[]
```

Turns the file paths of a built site into live paths, for `livePaths`. Each `.html` file gives its own path and its clean one, and `index.html` gives its folder: `['index.html', 'blog/index.html', 'about.html']` becomes `/`, `/index.html`, `/blog`, `/blog/index.html`, `/about` and `/about.html`. The CLI's `--pages` uses it.

### Flattening

```ts
flatten(rules, options?): { rules, problems, counts }
```

Returns the rule set a host should serve. Chains collapse to their final target, a chain into a 410 becomes a 410, and loops, malformed rules and repeated Froms are left out. Exact paths come first, then placeholders, then wildcards with the longest prefix first. `problems` is what `lint` would report, and `counts` is `{ input, output, collapsed, dropped }`.

```ts
flatten([
  { from: '/a', to: '/b', status: 301 },
  { from: '/b', to: '/c', status: 301 },
]).rules;
// [{ from: '/a', to: '/c', status: 301 }, { from: '/b', to: '/c', status: 301 }]
```

### Writing

| Export                               | Returns                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `toRedirects(rules, options?)`       | A `_redirects` file, in the order given. `/*` targets become `/:splat`, `force` becomes `!`, notes become comments. |
| `toCsv(rules)`                       | CSV with a `from,to,status,note` header.                                                                            |
| `toJson(rules)`                      | A JSON array.                                                                                                       |
| `serialize(rules, format, options?)` | The same, for any format.                                                                                           |

`toRedirects` takes `{ notes?: boolean; gonePage?: string }`. `notes` (default `true`) writes each note as a comment above its rule. `gonePage` (default `/410.html`) is the page named on a 410 rule, which the `_redirects` format requires.

### Planning an import

```ts
planImport(incoming, existing, options?): { rows, adds, updates, problems }
```

For tools that import a file into an existing rule set. A rule whose From already exists is an update (or a skip when nothing changes), any other rule an add, and a repeated From within the file is skipped. `problems` are the loops, chains, clashes and duplicates the incoming rules would cause next to the existing ones.

```ts
const { rules } = parseCsv(upload);
const plan = planImport(rules, currentRules, { livePaths });
```

## What it checks

Errors (the CLI exits `1`):

- `invalid-from`, `invalid-to`, `invalid-status`: a missing or malformed path, a target that isn't a path or `http(s)` address, a status that isn't allowed, a wildcard in the target without one in the From, a placeholder in the target that the From doesn't define. The rule is left out.
- `loop`: rules that lead back to themselves, directly or through wildcards and placeholders, with the rules that lead into the loop. A chain longer than `maxHops` counts as one.
- `parse-error`: a line or file that can't be read.

Warnings:

- `chain`: a redirect whose target redirects again, with the path it takes and the single hop that flattening gives.
- `duplicate`: two rules with the same From (`/a` and `/a/` count as the same, and so do `/p/:x` and `/p/:y`). The first one is used.
- `shadowed`: an earlier wildcard or placeholder rule matches everything this one does, so it is never reached on hosts that use the first match.
- `clash` (with `livePaths`): the From is a live page, or a wildcard or placeholder rule covers live pages.
- `unsupported`: valid on some hosts but not handled here, so the rule is skipped: query matching, conditions, host-specific rules, 200 rewrites and other statuses that aren't redirects, regex rows, and wildcards that aren't at the end of a path.

Notes:

- `disabled`: a CSV or JSON row that is turned off.
- `gone-target`: a 410 that was given a target, which is ignored.

## Limits

- It reads paths. Query matching (`/store id=:id`), conditions (`Country=us`), host-specific rules, regex rules and 200 rewrites are reported as `unsupported` and left out of the checks, and out of anything `flatten` writes. The CLI tells you how many rules a flattened file is missing.
- A wildcard is a trailing `/*` and matches paths below the prefix, not the prefix itself: `/blog/*` matches `/blog/post` and not `/blog`. A placeholder is a whole path segment, so `/a-:id` isn't one. Check how your host treats the edge cases.
- Paths are case-sensitive and a trailing slash is ignored. A query string in a target is treated as part of the path.
- Following a redirect means finding the rule that covers everything the target can produce. Where two rules only partly overlap, it doesn't guess.
- Hosts that take the first match use the order in the file, and `shadowed` reports where that order hides a rule. `flatten` always writes the most specific rule first, so it can make a rule that was hidden start working.
- A 410 in a `_redirects` file loses the page it names. `toRedirects` writes `gonePage` instead, `/410.html` by default. Check that your host supports 410 rules.
- `--pages` treats `.html` files as pages. It knows nothing about routes your framework or host generates.
- It doesn't fetch anything: it can't tell whether a target exists unless the page is in `livePaths`.
- `maxRows` applies to CSV only.

## License

MIT © Saimul Islam
