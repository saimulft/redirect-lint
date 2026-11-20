import type { Rule } from '../src/index.ts';

/** A rule, with the status defaulting to 301. */
export const rule = (from: string, to: string | null, status = 301): Rule => ({ from, to, status });
