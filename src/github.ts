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

/** A review-level submission (the body sent with Approve / Request Changes / Comment). */
export interface ReviewSummary {
  author: string;
  authorAvatar?: string;
  verdict: 'approved' | 'changes-requested' | 'commented' | 'dismissed';
  body: string;
  submittedAt: string;
  url: string;
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
  /** Chronological review-level summaries; empty-body comment shells are filtered out. */
  summaries: ReviewSummary[];
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

/** File content as of `sha` — the review-time version, for diff views. */
export async function fileAtRevision(cwd: string, sha: string, path: string): Promise<string> {
  const { stdout } = await exec('git', ['show', `${sha}:${path}`], { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
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

async function remoteRepo(cwd: string, remote: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', remote], { cwd });
    const m = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null; // remote doesn't exist
  }
}

/** origin = where the branch was pushed; upstream (fork workflow) = where the PR may live. */
export async function detectRepo(cwd: string): Promise<{
  origin: { owner: string; repo: string };
  upstream: { owner: string; repo: string } | null;
  branch: string;
}> {
  const origin = await remoteRepo(cwd, 'origin');
  if (!origin) {
    throw new Error('origin is missing or not a github.com remote');
  }
  const upstream = await remoteRepo(cwd, 'upstream');
  const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return { origin, upstream, branch: branch.trim() };
}

const THREAD_FIELDS = `
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
    pageInfo { hasNextPage endCursor }
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
}`;

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $branch: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, states: OPEN, first: $first) {
      totalCount
      nodes {
        number
        title
        url
        headRefOid
        headRepositoryOwner { login }
        reviews(last: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
          nodes {
            state
            body
            url
            submittedAt
            author { login avatarUrl }
          }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage endCursor }
          ${THREAD_FIELDS}
        }
      }
    }
  }
}`;

// tail pages of a chosen PR's threads — by number, so fork-filtered picks paginate correctly
const PR_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        ${THREAD_FIELDS}
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
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
  const { origin, upstream, branch } = await detectRepo(cwd);
  const accessToken = await token();

  // where the PR lives: origin first; the fork workflow falls back to upstream,
  // filtered to PRs whose head actually lives in our fork — branch names alone
  // collide across forks. The fallback costs one extra query and is the only
  // exception to refresh = one query.
  const findPr = async (owner: string, repo: string, first: number, headOwner: string | null) => {
    const data = await gql(accessToken, THREADS_QUERY, { owner, repo, branch, first });
    const conn = data.repository?.pullRequests;
    let nodes: any[] = conn?.nodes ?? [];
    if (headOwner) {
      nodes = nodes.filter((n) => n.headRepositoryOwner?.login === headOwner);
    }
    return { pr: nodes[0] ?? null, count: headOwner ? nodes.length : (conn?.totalCount ?? 0) };
  };

  let prOwner = origin.owner;
  let prRepo = origin.repo;
  let { pr, count: openPrCount } = await findPr(origin.owner, origin.repo, 1, null);
  if (!pr && upstream && (upstream.owner !== origin.owner || upstream.repo !== origin.repo)) {
    prOwner = upstream.owner;
    prRepo = upstream.repo;
    ({ pr, count: openPrCount } = await findPr(upstream.owner, upstream.repo, 10, origin.owner));
  }
  if (!pr) {
    return null;
  }

  const rawThreads: any[] = [...(pr.reviewThreads?.nodes ?? [])];
  let cursor: string | null = pr.reviewThreads?.pageInfo?.hasNextPage
    ? pr.reviewThreads.pageInfo.endCursor
    : null;
  while (cursor) {
    const data = await gql(accessToken, PR_THREADS_QUERY, {
      owner: prOwner,
      repo: prRepo,
      number: pr.number,
      cursor,
    });
    const conn = data.repository?.pullRequest?.reviewThreads;
    if (!conn) {
      break;
    }
    rawThreads.push(...(conn.nodes ?? []));
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  }

  // long threads: pull the comment tail so nothing is silently truncated
  for (const t of rawThreads) {
    let commentCursor: string | null = t.comments?.pageInfo?.hasNextPage ? t.comments.pageInfo.endCursor : null;
    while (commentCursor) {
      const data = await gql(accessToken, THREAD_COMMENTS_QUERY, { id: t.id, cursor: commentCursor });
      const conn = data.node?.comments;
      if (!conn) {
        break;
      }
      t.comments.nodes.push(...(conn.nodes ?? []));
      commentCursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    }
  }

  const headSha: string = pr.headRefOid;
  const verdictOf: Record<string, ReviewSummary['verdict']> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes-requested',
    COMMENTED: 'commented',
    DISMISSED: 'dismissed',
  };
  // ponytail: last 20 reviews — a PR with more re-review rounds than that is off the map
  const summaries: ReviewSummary[] = (pr.reviews?.nodes ?? [])
    .filter((r: any) => {
      const verdict = verdictOf[r.state];
      // bodyless COMMENTED/DISMISSED reviews are shells around inline comments — noise;
      // bodyless approvals/change-requests still carry the verdict itself
      return verdict && (r.body?.trim() || verdict === 'approved' || verdict === 'changes-requested');
    })
    .map((r: any) => ({
      author: r.author?.login ?? 'unknown',
      authorAvatar: r.author?.avatarUrl,
      verdict: verdictOf[r.state],
      body: r.body ?? '',
      submittedAt: r.submittedAt ?? '',
      url: r.url,
    }));
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
    summaries,
  };
}
