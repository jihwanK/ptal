// Pure markdown builder for the review-summaries preview — no vscode imports,
// so it stays unit-testable alongside lineMapper.
import type { ReviewSummary } from './github';

const VERDICT_LABEL: Record<ReviewSummary['verdict'], string> = {
  approved: '✓ Approved',
  'changes-requested': '✗ Changes requested',
  commented: '💬 Commented',
  dismissed: '⊘ Dismissed',
};

export function summariesMarkdown(label: string, title: string, summaries: ReviewSummary[]): string {
  const head = `# ${label} — ${title}\n`;
  if (summaries.length === 0) {
    return `${head}\nNo review summaries yet — reviews submitted with Approve / Request Changes will show up here.\n`;
  }
  const sections = summaries.map((s) => {
    const when = s.submittedAt ? ` · ${new Date(s.submittedAt).toLocaleString()}` : '';
    const body = s.body.trim() ? `\n${s.body.trim()}\n` : '';
    return `## ${VERDICT_LABEL[s.verdict]} — ${s.author}${when}\n${body}\n[View on GitHub](${s.url})\n`;
  });
  return `${head}\n${sections.join('\n---\n\n')}`;
}
