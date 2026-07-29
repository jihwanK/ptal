import { describe, it, expect } from 'vitest';
import { mapLine, matchSnippet, parseHunks } from '../lineMapper';

describe('mapLine — diff hunk arithmetic', () => {
  it('identity when diff is empty', () => {
    expect(mapLine('', 42)).toBe(42);
  });

  it('shifts down past an insertion above', () => {
    const diff = ['@@ -2,0 +3,2 @@', '+inserted a', '+inserted b'].join('\n');
    expect(mapLine(diff, 10)).toBe(12);
  });

  it('insertion point itself is unaffected', () => {
    const diff = ['@@ -2,0 +3,2 @@', '+inserted a', '+inserted b'].join('\n');
    expect(mapLine(diff, 2)).toBe(2);
    expect(mapLine(diff, 1)).toBe(1);
  });

  it('shifts up past a deletion above', () => {
    const diff = ['@@ -3,2 +2,0 @@', '-gone a', '-gone b'].join('\n');
    expect(mapLine(diff, 10)).toBe(8);
  });

  it('returns null when the anchor line was deleted', () => {
    const diff = ['@@ -3,2 +2,0 @@', '-gone a', '-gone b'].join('\n');
    expect(mapLine(diff, 3)).toBeNull();
    expect(mapLine(diff, 4)).toBeNull();
  });

  it('returns null when the anchor line was rewritten in place', () => {
    const diff = ['@@ -5,3 +5,3 @@', ' ctx before', '-old version', '+new version', ' ctx after'].join('\n');
    expect(mapLine(diff, 6)).toBeNull();
  });

  it('maps a context line inside a hunk', () => {
    const diff = ['@@ -5,3 +5,4 @@', ' ctx1', '+added', ' ctx2', ' ctx3'].join('\n');
    expect(mapLine(diff, 5)).toBe(5);
    expect(mapLine(diff, 6)).toBe(7);
    expect(mapLine(diff, 7)).toBe(8);
  });

  it('lines just outside hunk boundaries are shifted, not walked', () => {
    const diff = ['@@ -5,3 +5,4 @@', ' ctx1', '+added', ' ctx2', ' ctx3'].join('\n');
    expect(mapLine(diff, 4)).toBe(4); // before hunk
    expect(mapLine(diff, 8)).toBe(9); // after hunk: +1 net
  });

  it('accumulates offsets across multiple hunks', () => {
    const diff = [
      '@@ -2,0 +3,1 @@',
      '+one',
      '@@ -10,0 +12,1 @@',
      '+two',
    ].join('\n');
    expect(mapLine(diff, 20)).toBe(22);
    expect(mapLine(diff, 5)).toBe(6); // only first hunk applies
  });

  it('ignores "no newline at end of file" markers', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' keep', '-old tail', '+new tail', '\\ No newline at end of file'].join('\n');
    expect(mapLine(diff, 1)).toBe(1);
  });

  it('parses headers with omitted lengths (@@ -a +c @@)', () => {
    const hunks = parseHunks('@@ -3 +5 @@\n-x\n+y');
    expect(hunks[0]).toMatchObject({ oldStart: 3, oldLen: 1, newStart: 5, newLen: 1 });
  });
});

describe('matchSnippet — content fallback', () => {
  const hunk = (...lines: string[]) => ['@@ -1,3 +1,3 @@', ...lines].join('\n');

  it('finds a unique target line', () => {
    const file = ['a', 'const total = sum(items);', 'b'].join('\n');
    expect(matchSnippet(file, hunk(' x', ' y', '+const total = sum(items);'))).toBe(2);
  });

  it('disambiguates duplicates using preceding context', () => {
    const file = ['function a() {', '  return 1;', '}', 'function b() {', '  return 1;', '}'].join('\n');
    const snippet = hunk(' function b() {', '+  return 1;');
    expect(matchSnippet(file, snippet)).toBe(5);
  });

  it('returns null when duplicates cannot be disambiguated', () => {
    const file = ['}', '}'].join('\n');
    expect(matchSnippet(file, hunk('+}'))).toBeNull();
  });

  it('returns null when the comment targets a deleted line', () => {
    expect(matchSnippet('anything', hunk(' keep', '-removed line'))).toBeNull();
  });

  it('returns null when the content is gone', () => {
    expect(matchSnippet('completely different file', hunk('+vanished line'))).toBeNull();
  });

  it('falls back to whitespace-insensitive matching after re-indentation', () => {
    const file = ['if (x) {', '        const y = 1;', '}'].join('\n');
    expect(matchSnippet(file, hunk('+  const y = 1;'))).toBe(2);
  });
});
