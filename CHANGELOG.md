# Changelog

## 0.1.0

Initial release.

- Reads redirect rules from Netlify and Cloudflare Pages `_redirects` files, CSV (including WordPress Redirection exports) and JSON, and writes them back in any of the three.
- Checks a rule set for loops, chains, duplicate Froms, rules hidden by an earlier wildcard, malformed paths, targets and statuses, and redirects that shadow live pages.
- Understands wildcards, `:placeholders`, `:splat`, 410s and the `!` force flag.
- Flattens chains into single redirects and orders the result most specific first.
- Reports query matching, conditions, rewrites and regex rows as unsupported instead of guessing.
- Command line: `redirect-lint <file>` with `--pages`, `--flatten`, `--out` and `--json`.
