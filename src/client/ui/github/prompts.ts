import type { AgentEffort, AgentProvider, GhIssue, GhMergeMethod, GhPull } from '../../../shared/protocol';
import { repoName, sameGh, sameRepo } from '../../../shared/floors';
import { store } from '../../state';
import { repoUrlOf } from '../markdown';
import type { MeetingPreset } from '../meeting';
import { officePrompt } from '../prompts';

// ---- Prompts for workers ------------------------------------------------------------------------

export interface BoardActions {
  /**
   * Start a worker on a ready-made prompt (shown for editing first). With `issue`, the worker takes that
   * GitHub issue, which moves to In progress. `repo` is the repository it's about, on a team floor.
   */
  assign(prompt: string, title: string, issue?: number, repo?: string): void;
  /** Your own prompt about an issue or PR; `context` goes first so the worker knows which. */
  ask(context: string, title: string): void;
  /** Walks you to the desk a pull request came from. */
  goToDesk(deskId: string): void;
  /** Put an issue on the 📋 task queue; a worker is seated for it when there's room. */
  queue(prompt: string, title: string, issue: number, provider?: AgentProvider, model?: string, effort?: AgentEffort, repo?: string): void;
  /** Take the issue's card off the board, to carry to a desk or the queue (not on the 2D view, where there's nobody to carry it). */
  pickUp?(issue: GhIssue): void;
  /** Call a meeting about it: the meeting room's form, filled in. */
  meeting(preset: MeetingPreset): void;
}

/** The task a worker gets for an issue, from the board, a carried card or the queue (the 'issue.work' prompt). */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title' | 'repo'> & { url?: string }): string {
  return withRepo(officePrompt('issue.work', issueVars(it)), it.repo);
}

/** What an issue's prompts fill in. A carried card has no URL, but the board usually knows it. */
export function issueVars(it: Pick<GhIssue, 'number' | 'title' | 'repo'> & { url?: string }) {
  return { number: it.number, title: it.title, url: it.url ?? store.issues.items.find((i) => sameGh(i, it.number, it.repo))?.url ?? '' };
}

/**
 * A prompt about an issue or pull request on a team floor, which has several repositories: the
 * office's prompts say #12 and run gh as if there were one, so it's told which, and where it is.
 */
export function withRepo(text: string, repo: string | undefined): string {
  if (!repo || !text.trim()) return text;
  const folder = store.currentFloor()?.repos?.find((r) => sameRepo(r.repo, repo))?.path ?? repoName(repo);
  return `${text}\n\nOn this floor it's in ${repo}, checked out in the \`${folder}/\` folder: run gh and git in there (or pass -R ${repo} to gh), and write its number as ${repo}#n anywhere else.`;
}

/** owner/repo from a PR or issue URL. */
function nameWithOwner(url: string): string {
  return repoUrlOf(url).replace(/^https?:\/\/[^/]+\//, '');
}

/** What a pull request's prompts fill in. */
export function pullVars(it: GhPull) {
  return { number: it.number, title: it.title, url: it.url, branch: it.headRefName, base: it.baseRefName };
}

export function reviewPrompt(it: GhPull) {
  return withRepo(officePrompt('pull.review', pullVars(it)), it.repo);
}

function mergeCommand(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return `gh pr merge ${it.number} --${method}${deleteBranch ? ' --delete-branch' : ''} --repo ${nameWithOwner(it.url)}`;
}

function mergeVars(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return { ...pullVars(it), repo: nameWithOwner(it.url), merge: mergeCommand(it, method, deleteBranch) };
}

export function fixAndMergePrompt(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return withRepo(officePrompt('pull.fixMerge', mergeVars(it, method, deleteBranch)), it.repo);
}

export function fixConflictsPrompt(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return withRepo(officePrompt('pull.fixConflicts', mergeVars(it, method, deleteBranch)), it.repo);
}

export function pullContext(it: GhPull) {
  return withRepo(officePrompt('pull.ask', pullVars(it)), it.repo);
}

export function issueContext(it: GhIssue) {
  return withRepo(officePrompt('issue.ask', issueVars(it)), it.repo);
}
