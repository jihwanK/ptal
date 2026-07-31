import { describe, expect, it } from 'vitest';
import { summariesMarkdown } from '../summaryMarkdown';
import type { ReviewSummary } from '../github';

const base: ReviewSummary = {
  author: 'codex',
  verdict: 'changes-requested',
  body: 'Found 3 issues worth fixing.',
  submittedAt: '2026-07-30T14:22:00Z',
  url: 'https://github.com/o/r/pull/12#pullrequestreview-1',
};

describe('summariesMarkdown', () => {
  it('renders an empty state with the PR heading', () => {
    const md = summariesMarkdown('PR #12', 'Fix races', []);
    expect(md).toContain('# PR #12 — Fix races');
    expect(md).toContain('No review summaries yet');
  });

  it('renders verdict, author, body, and GitHub link', () => {
    const md = summariesMarkdown('PR #12', 'Fix races', [base]);
    expect(md).toContain('✗ Changes requested — codex');
    expect(md).toContain('Found 3 issues worth fixing.');
    expect(md).toContain('[View on GitHub](https://github.com/o/r/pull/12#pullrequestreview-1)');
  });

  it('keeps a bodyless approval as a verdict-only section', () => {
    const md = summariesMarkdown('PR #12', 'Fix races', [
      { ...base, verdict: 'approved', body: '', author: 'alice' },
    ]);
    expect(md).toContain('✓ Approved — alice');
    expect(md).not.toContain('undefined');
  });

  it('separates multiple reviews with a rule, in given order', () => {
    const md = summariesMarkdown('PR #12', 'Fix races', [
      base,
      { ...base, verdict: 'approved', author: 'alice', body: 'LGTM after the fixes!' },
    ]);
    expect(md.indexOf('codex')).toBeLessThan(md.indexOf('alice'));
    expect(md).toContain('\n---\n');
  });
});
