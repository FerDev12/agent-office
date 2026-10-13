// What a worker's status means, for the checks the server and the browser both make.

import { repoOfUrl, sameRepo } from './floors.js';
import type { GhPull, QueueTask, WorkerInfo, WorkerStatus } from './protocol.js';

/** Its process isn't running: it exited, or came back asleep after a restart. R wakes it. */
export function isAsleep(status: WorkerStatus): boolean {
  return status === 'exited' || status === 'offline';
}

/** In the middle of a turn: booting, working, or waiting on an answer. */
export function isBusy(status: WorkerStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'needs_input';
}

/**
 * One line for a notification about a worker: what it's asking for when it needs input, or what it
 * was on when it's done (its last activity may be a permission prompt it has long got past).
 */
export function alertDetail(w: WorkerInfo): string | undefined {
  return w.status === 'needs_input' ? (w.activity ?? w.task?.summary) : (w.task?.summary ?? w.prompt);
}

/** A worker's pull request: still open, or merged (time to send it home). */
export interface WorkerPr {
  state: 'open' | 'merged';
  number: number;
  /** owner/name of its repository, on a team floor. */
  repo?: string;
}

/**
 * Where its work stands on GitHub: a pull request from its desk, its worktree branch or its queue
 * task, or one it opened itself, is open (one still open wins, e.g. a follow-up on the same branch), or merged, so it can be
 * sent home. Undefined when it has none, or only closed ones.
 *
 * On a team floor `pulls` has every one of its repositories' pull requests, whose numbers can be the
 * same: one is known by the repository in its URL, and by number or branch alone only in the
 * repository the worker's worktree is of (else the one its own pull request is in).
 */
export function workerPr(w: WorkerInfo, pulls: GhPull[], tasks: QueueTask[]): WorkerPr | undefined {
  const home = w.worktree?.repo ?? repoOfUrl(w.pr?.url);
  const inHome = (p: GhPull) => !p.repo || !home || sameRepo(p.repo, home);
  const refs: { number: number; url?: string }[] = [];
  if (w.pr) refs.push(w.pr);
  for (const n of w.pastPrs ?? []) refs.push({ number: n });
  const ownTasks = tasks.filter((t) => t.workerId === w.id && t.pr);
  for (const t of ownTasks) refs.push(t.pr!);
  const isRef = (p: GhPull, r: { number: number; url?: string }) => {
    const where = repoOfUrl(r.url);
    return p.number === r.number && (where && p.repo ? sameRepo(where, p.repo) : inHome(p));
  };
  const listed = (r: { number: number; url?: string }) => pulls.some((p) => isRef(p, r));
  const seen = pulls
    .filter((p) => refs.some((r) => isRef(p, r)) || (w.worktree && w.worktree.branch === p.headRefName && inHome(p)))
    .map((p) => ({ number: p.number, state: p.state, repo: p.repo }));
  // Its task's PR can drop off the list GitHub sends (the last 30 merged): keep what the queue saw.
  for (const t of ownTasks) if (!listed(t.pr!)) seen.push({ number: t.pr!.number, state: t.pr!.state, repo: repoOfUrl(t.pr!.url) });
  // Opened from its desk but not on the list yet (still loading, or no gh to ask): it's open.
  if (w.pr && !listed(w.pr)) seen.push({ number: w.pr.number, state: 'OPEN', repo: repoOfUrl(w.pr.url) });
  const open = seen.find((p) => p.state === 'OPEN' || p.state === 'DRAFT');
  const pick = open ?? seen.find((p) => p.state === 'MERGED');
  if (!pick) return undefined;
  const repo = pulls.some((p) => p.repo) ? pick.repo : undefined;
  return { state: open ? 'open' : 'merged', number: pick.number, ...(repo ? { repo } : {}) };
}
