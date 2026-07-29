// Maps a review-time anchor line to the current working tree.
// Stage 1: diff hunk arithmetic (exact). Stage 2: snippet content matching.
// Stage 3: honest failure — never silently point at the wrong line.
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fsp from 'fs/promises';
import { join } from 'path';

const run = promisify(execFile);

export interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  /** Body lines including their ' '/'+'/'-' prefix. */
  lines: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diffText.split('\n')) {
    const m = line.match(HUNK_RE);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLen: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLen: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
    } else {
      current = null; // file headers, empty tail, etc.
    }
  }
  return hunks;
}

export interface LineMatch {
  line: number;
  /** false when the original line was deleted/rewritten — `line` is where its replacement lives. */
  exact: boolean;
}

/**
 * Translate a 1-based line number in the old file to the new file.
 * A deleted/rewritten line maps to the new-side position of the hunk that
 * consumed it (the replacement code), flagged exact: false.
 * Returns null only for malformed diffs.
 */
export function mapLine(diffText: string, oldLine: number): LineMatch | null {
  let offset = 0;
  for (const h of parseHunks(diffText)) {
    if (h.oldLen === 0) {
      // pure insertion after old line h.oldStart
      if (oldLine <= h.oldStart) break;
      offset += h.newLen;
      continue;
    }
    if (oldLine < h.oldStart) break;
    if (oldLine > h.oldStart + h.oldLen - 1) {
      offset += h.newLen - h.oldLen;
      continue;
    }
    // inside the hunk: walk body lines
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const c = l[0];
      if (c === ' ') {
        if (o === oldLine) return { line: n, exact: true };
        o++;
        n++;
      } else if (c === '-') {
        if (o === oldLine) return { line: n, exact: false }; // replacement code starts here
        o++;
      } else if (c === '+') {
        n++;
      }
    }
    return null; // malformed hunk; treat as lost rather than guess
  }
  return { line: oldLine + offset, exact: true };
}

/**
 * Locate the commented line in the current file using the review-time diff hunk.
 * The commented line is the last line of the hunk (platform convention).
 * Widens context until the match is unique; retries whitespace-insensitively.
 * Returns a 1-based line number, or null when absent or ambiguous.
 */
export function matchSnippet(fileText: string, diffHunk: string): number | null {
  const body = diffHunk.split('\n').filter((l) => /^[ +-]/.test(l));
  if (body.length === 0) return null;
  if (body[body.length - 1].startsWith('-')) return null; // comment targets a deleted line

  // Lines visible at review time (context + added), prefixes stripped; target is last.
  const visible = body.filter((l) => l[0] !== '-').map((l) => l.slice(1));
  if (visible.length === 0) return null;
  const fileLines = fileText.split('\n');

  const findAll = (needle: string[], trim: boolean): number[] => {
    const found: number[] = [];
    outer: for (let i = 0; i <= fileLines.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        const a = trim ? fileLines[i + j].trim() : fileLines[i + j];
        const b = trim ? needle[j].trim() : needle[j];
        if (a !== b) continue outer;
      }
      found.push(i);
    }
    return found;
  };

  for (const trim of [false, true]) {
    for (let k = 1; k <= visible.length; k++) {
      const needle = visible.slice(visible.length - k);
      const found = findAll(needle, trim);
      if (found.length === 1) return found[0] + needle.length; // 1-based line of the target
      if (found.length === 0) break; // widening can only shrink the match set
    }
  }
  return null;
}

export type MappedAnchor =
  | { line: number; startLine?: number; confidence: 'exact' | 'approx' | 'content' }
  | { line: null; confidence: 'lost'; reason: 'anchor-missing' | 'content-changed' };

/** Full fallback chain for one thread anchor. */
export async function mapAnchor(opts: {
  cwd: string;
  path: string;
  anchorSha: string;
  anchorLine: number | null;
  anchorStartLine?: number | null;
  snippet: string;
}): Promise<MappedAnchor> {
  let anchorMissing = false;
  if (opts.anchorLine !== null) {
    try {
      // anchor commit → working tree, uncommitted changes included.
      // ponytail: no rename following — a renamed file falls through to content matching.
      const { stdout } = await run(
        'git',
        ['diff', '--no-color', opts.anchorSha, '--', opts.path],
        { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 },
      );
      const res = mapLine(stdout, opts.anchorLine);
      if (res !== null) {
        const line = Math.max(1, res.line);
        // multi-line range: map the start through the same diff; drop it if it
        // fails or inverts rather than showing a wrong-looking span
        let startLine: number | undefined;
        if (opts.anchorStartLine != null && opts.anchorStartLine < opts.anchorLine) {
          const s = mapLine(stdout, opts.anchorStartLine);
          if (s !== null && s.line >= 1 && s.line <= line) startLine = s.line;
        }
        return { line, startLine, confidence: res.exact ? 'exact' : 'approx' };
      }
    } catch {
      // anchor commit missing locally (behind the PR, rebase/force-push, shallow clone)
      anchorMissing = true;
    }
  }
  try {
    const fileText = await fsp.readFile(join(opts.cwd, opts.path), 'utf8');
    const line = matchSnippet(fileText, opts.snippet);
    if (line !== null) return { line, confidence: 'content' };
  } catch {
    // file no longer exists
  }
  return { line: null, confidence: 'lost', reason: anchorMissing ? 'anchor-missing' : 'content-changed' };
}
