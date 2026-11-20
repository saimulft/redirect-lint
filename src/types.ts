/** How serious a problem is. Errors make the CLI exit with 1. */
export type Severity = 'error' | 'warning' | 'info';

/**
 * What a problem is about.
 *
 * - `parse-error`: the file or a line could not be read.
 * - `invalid-from`, `invalid-to`, `invalid-status`: the rule is malformed and is left out.
 * - `unsupported`: valid on some hosts but not understood here (query matching, conditions, regex, rewrites).
 * - `disabled`: the row is switched off in the file.
 * - `gone-target`: a 410 has no target, so the one given is ignored.
 * - `loop`: the rule leads back to itself, or passes through too many redirects.
 * - `chain`: the rule redirects to a path that redirects again.
 * - `clash`: the rule's From is a live page.
 * - `duplicate`: another rule has the same From, so only the first one is used.
 * - `shadowed`: an earlier, broader rule always matches first, so this one is never reached.
 */
export type ProblemCode =
  | 'parse-error'
  | 'invalid-from'
  | 'invalid-to'
  | 'invalid-status'
  | 'unsupported'
  | 'disabled'
  | 'gone-target'
  | 'loop'
  | 'chain'
  | 'clash'
  | 'duplicate'
  | 'shadowed';

/** A file format redirect-lint reads and writes. */
export type Format = 'csv' | 'redirects' | 'json';

/** Where a rule came from: a 1-based line of a CSV or `_redirects` file, or a 0-based index in a JSON array. */
export interface RuleLocation {
  line?: number;
  index?: number;
}

/** One redirect rule. */
export interface Rule extends RuleLocation {
  /**
   * The path to redirect from, such as `/old`. A trailing `/*` makes it a wildcard (`/blog/*`) and a segment like
   * `:id` is a placeholder for one path segment.
   */
  from: string;
  /**
   * The target: a path, or a full `http(s)://` address. A trailing `/*` puts the wildcard's rest there, and
   * `:id` puts a placeholder's value there. `null` for a 410.
   */
  to: string | null;
  /** The HTTP status, such as 301 or 410. */
  status: number;
  /** A free-text note (the title column of a CSV). */
  note?: string;
  /** Set by a `!` after the status in a `_redirects` file: the rule applies even where a file exists. */
  force?: boolean;
}

/** One thing worth knowing about a rule or a rule set. */
export interface Problem extends RuleLocation {
  code: ProblemCode;
  severity: Severity;
  message: string;
  /** The From of the rule the problem is about, when it is about one. */
  from?: string;
  /** Other rules the problem involves, such as the rest of a chain or loop. */
  related?: RuleLocation[];
}

/** Options for the parse functions. */
export interface ParseOptions {
  /** Statuses a rule may have. Default: 301, 302, 303, 307, 308 and 410. */
  statuses?: readonly number[];
  /** Longest From, in characters. Default: 500. */
  maxFromLength?: number;
  /** Longest target, in characters. Default: 1000. */
  maxToLength?: number;
  /** Longest note kept, in characters (CSV and JSON). Default: 500. */
  maxNoteLength?: number;
  /** Most rows a CSV file may have; more is a parse error. Default: 5000. */
  maxRows?: number;
}

/** Options for `lint`, `flatten` and `planImport`. */
export interface LintOptions {
  /** Paths of live pages, to find redirects that shadow them. */
  livePaths?: Iterable<string>;
  /** Statuses a rule may have. Default: 301, 302, 303, 307, 308 and 410. */
  statuses?: readonly number[];
  /** How many redirects a chain may pass through before it counts as a loop. Default: 20. */
  maxHops?: number;
  /** Longest From, in characters. Default: 500. */
  maxFromLength?: number;
  /** Longest target, in characters. Default: 1000. */
  maxToLength?: number;
}

/** What a parse function returns: the usable rules, and why the other rows were left out. */
export interface ParseResult {
  rules: Rule[];
  problems: Problem[];
}

/** What `flatten` returns. */
export interface FlattenResult {
  /** The final rule set: chains collapsed, loops, invalid rules and duplicates left out, most specific first. */
  rules: Rule[];
  /** The same problems `lint` reports for the input. */
  problems: Problem[];
  counts: {
    /** Rules passed in. */
    input: number;
    /** Rules in the result. */
    output: number;
    /** Rules whose target changed because they started a chain. */
    collapsed: number;
    /** Rules left out. */
    dropped: number;
  };
}

/** Options for the serialisers. */
export interface SerializeOptions {
  /** `_redirects` only: write each rule's note as a comment above it. Default: true. */
  notes?: boolean;
  /** `_redirects` only: the page named on a 410 rule, which that format needs. Default: `/410.html`. */
  gonePage?: string;
}
