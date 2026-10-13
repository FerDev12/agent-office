/**
 * Hiring, as the 3D office and the 2D view (/lite) both do it. No three.js here: the 2D view imports it.
 */
import { repoName, sameRepo, teamRepoKey } from '../../shared/floors';
import { store } from '../state';

/** A repository a new worker in its own worktree can work in (see WorkerInfo.repos and worker.spawn's `repos`). */
export interface HireRepo {
  id: string;
  name: string;
  /** One of the team floor's own repositories, which the worker's worktrees are of. */
  own?: boolean;
  /** Ticked to start with: on a team floor, its own repositories, or just the one the task is about. */
  picked?: boolean;
}

/**
 * The repositories a new worker can work in, each in a worktree of its own: on a team floor, its own
 * repositories first (all ticked, or only `about`'s when the task is about one of them), then the
 * building's other projects and other team floors' repositories.
 */
export function repoChoices(about?: string): HireRepo[] {
  const here = store.currentFloor();
  const ready = <T extends { cloning?: boolean }>(list: T[] | undefined) => (list ?? []).filter((r) => !r.cloning);
  const focus = about && ready(here?.repos).some((r) => sameRepo(r.repo, about)) ? about : undefined;
  const own: HireRepo[] = here?.team ? ready(here.repos).map((r) => ({ id: teamRepoKey(here.id, r.path), name: repoName(r.repo), own: true, picked: !focus || sameRepo(r.repo, focus) })) : [];
  const others = store.floors
    .filter((f) => f.id !== store.floor && !f.cloning)
    .flatMap((f): HireRepo[] => (f.team ? ready(f.repos).map((r) => ({ id: teamRepoKey(f.id, r.path), name: `${repoName(r.repo)} (${f.name})` })) : f.branch ? [{ id: f.id, name: f.name }] : []));
  return [...own, ...others];
}

/** Whether a new worker here can have its own git worktree: the project is a git checkout, or a team floor has a repository. */
export function canWorktree(): boolean {
  const here = store.currentFloor();
  return here?.team ? !!here.repos?.some((r) => !r.cloning) : !!store.project?.branch;
}
