// The only file that knows GitHub. Everything it exports uses neutral vocabulary —
// GitHub GraphQL field names must not leak past this module.
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface ReviewComment {
  id: string;
  author: string;
  authorAvatar?: string;
  body: string;
  url: string;
  /** Review-time diff hunk text: fallback content matching + frozen-context display. */
  snippet: string;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  /** Commit the anchor line refers to (PR head, or review-time commit when outdated). */
  anchorSha: string;
  /** 1-based line in the anchor commit's version of the file; null if the platform lost it. */
  anchorLine: number | null;
  /** First line of a multi-line comment range; null for single-line comments. */
  anchorStartLine: number | null;
  isOutdated: boolean;
  isResolved: boolean;
  comments: ReviewComment[];
}

export interface ReviewSet {
  /** Display label supplied by the provider, e.g. "PR #42". */
  label: string;
  title: string;
  url: string;
  headSha: string;
  /** Open PRs sharing this head branch (different bases); we show the oldest. */
  openPrCount: number;
  threads: ReviewThread[];
}

/** Git repository root — file paths in review threads are relative to this. */
export async function repoRoot(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return stdout.trim();
}

/** Absolute git dir — worktree-safe home of HEAD, for branch-switch watching. */
export async function gitDir(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd });
  return stdout.trim();
}

/** True when `sha` is part of local history (i.e. the checkout is not behind it). */
export async function localContains(cwd: string, sha: string): Promise<boolean> {
  try {
    await exec('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd });
    return true;
  } catch {
    return false; // unknown sha or not an ancestor — either way, positions may be stale
  }
}

export async function detectRepo(cwd: string): Promise<{ owner: string; repo: string; branch: string }> {
  const { stdout: url } = await exec('git', ['remote', 'get-url', 'origin'], { cwd });
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    throw new Error(`origin is not a github.com remote: ${url.trim()}`);
  }
  const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return { owner: m[1], repo: m[2], branch: branch.trim() };
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $branch: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, states: OPEN, first: 1) {
      totalCount
      nodes {
        number
        title
        url
        headRefOid
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            line
            originalLine
            startLine
            originalStartLine
            diffSide
            isResolved
            isOutdated
            comments(first: 50) {
              nodes {
                id
                body
                url
                createdAt
                diffHunk
                author { login avatarUrl }
                originalCommit { oid }
              }
            }
          }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

const UNRESOLVE_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

async function token(): Promise<string> {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
  return session.accessToken;
}

export async function replyToThread(threadId: string, body: string): Promise<void> {
  await gql(await token(), REPLY_MUTATION, { threadId, body });
}

let viewerCache: { login: string; avatarUrl?: string } | null = null;

/** The signed-in user, for optimistic UI. Cached for the session. */
export async function viewer(): Promise<{ login: string; avatarUrl?: string }> {
  if (!viewerCache) {
    const data = await gql(await token(), 'query { viewer { login avatarUrl } }', {});
    viewerCache = data.viewer;
  }
  return viewerCache!;
}

export async function resolveThread(threadId: string): Promise<void> {
  await gql(await token(), RESOLVE_MUTATION, { threadId });
}

export async function unresolveThread(threadId: string): Promise<void> {
  await gql(await token(), UNRESOLVE_MUTATION, { threadId });
}

async function gql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ptal-vscode',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json: any = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

function toThread(node: any): ReviewThread {
  const comments: ReviewComment[] = (node.comments?.nodes ?? []).map((c: any) => ({
    id: c.id,
    author: c.author?.login ?? 'unknown',
    authorAvatar: c.author?.avatarUrl,
    body: c.body ?? '',
    url: c.url,
    snippet: c.diffHunk ?? '',
    createdAt: c.createdAt,
  }));
  // LEFT-side threads target a deleted line: their numbers are base-side, so hunk
  // arithmetic against the head commit would silently land on the wrong line.
  // Null anchorLine routes them to the snippet fallback (honest failure + frozen context).
  const leftSide = node.diffSide === 'LEFT';
  return {
    id: node.id,
    path: node.path,
    anchorSha: '', // filled by caller: needs headRefOid for the non-outdated case
    anchorLine: leftSide ? null : node.isOutdated ? node.originalLine : node.line,
    anchorStartLine: leftSide ? null : node.isOutdated ? node.originalStartLine : node.startLine,
    isOutdated: node.isOutdated,
    isResolved: node.isResolved,
    comments,
  };
}

/** Fetch the open PR for the current branch and all its review threads. Null when no PR. */
export async function fetchReviewSet(cwd: string): Promise<ReviewSet | null> {
  const { owner, repo, branch } = await detectRepo(cwd);
  const accessToken = await token();

  let pr: any = null;
  let openPrCount = 0;
  const rawThreads: any[] = [];
  let cursor: string | null = null;
  do {
    const data = await gql(accessToken, THREADS_QUERY, { owner, repo, branch, cursor });
    pr = data.repository?.pullRequests?.nodes?.[0];
    openPrCount = data.repository?.pullRequests?.totalCount ?? 0;
    if (!pr) {
      return null;
    }
    rawThreads.push(...(pr.reviewThreads?.nodes ?? []));
    const page = pr.reviewThreads?.pageInfo;
    cursor = page?.hasNextPage ? page.endCursor : null;
  } while (cursor);

  const headSha: string = pr.headRefOid;
  const threads = rawThreads.map((n) => {
    const t = toThread(n);
    t.anchorSha = t.isOutdated ? (n.comments?.nodes?.[0]?.originalCommit?.oid ?? headSha) : headSha;
    return t;
  });

  return {
    label: `PR #${pr.number}`,
    title: pr.title,
    url: pr.url,
    headSha,
    openPrCount,
    threads,
  };
}
