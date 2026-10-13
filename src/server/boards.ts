// A floor's GitHub boards: one repository's issues and pull requests (a project's checkout), or every
// repository of a team floor's together, each card saying which it's in (GhIssue.repo).
import type { GhIssue, GhPull, GhState } from '../shared/protocol.js';
import { repoName, sameRepo } from '../shared/floors.js';
import { GitHub, gh } from './github.js';
import type { GhAs } from './signins.js';

/** A checkout the boards show: a project's (no `repo` needed), or one of a team floor's repositories. */
export interface BoardSource {
  /** owner/name, for a team floor's repository: its cards say so, and actions on them name it. */
  repo?: string;
  dir: string;
}

type Runner = ConstructorParameters<typeof GitHub>[3];

const EMPTY = (): GhState<never> => ({ items: [], fetchedAt: 0, loading: false });

/**
 * The boards of one floor. A floor that is one project's checkout has one GitHub, and its lists are
 * that one's, untouched. A team floor has one per repository (maybe none), and its lists are all of
 * theirs put together; an issue or pull request is then known by its number and its repository.
 */
export class Boards {
  issues: GhState<GhIssue> = EMPTY();
  pulls: GhState<GhPull> = EMPTY();
  /** By repository (lower-cased owner/name; '' for a project's own checkout), in the order they came. */
  private boards = new Map<string, GitHub>();

  constructor(
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    private runGh: Runner = gh,
  ) {}

  /**
   * Shows these checkouts: a board for each new one, and the ones no longer there taken down. Resolves
   * once the new ones have been asked about.
   */
  set(sources: BoardSource[]): Promise<void> {
    const keep = new Set(sources.map((s) => key(s.repo)));
    for (const [k, board] of this.boards) {
      if (keep.has(k)) continue;
      board.stop();
      this.boards.delete(k);
    }
    const fresh: GitHub[] = [];
    for (const s of sources) {
      if (this.boards.has(key(s.repo))) continue;
      const board = new GitHub(s.dir, () => this.gatherIssues(), () => this.gatherPulls(), this.runGh, s.repo);
      this.boards.set(key(s.repo), board);
      fresh.push(board);
    }
    this.gatherIssues();
    this.gatherPulls();
    return Promise.all(fresh.map((b) => b.refresh())).then(() => undefined);
  }

  /** The repositories it shows (owner/name), on a team floor. */
  repos(): string[] {
    return [...this.boards.values()].flatMap((b) => (b.repo ? [b.repo] : []));
  }

  /**
   * The board of the repository an issue or pull request is in: `repo` on a team floor, or the only
   * one there is. Why there's none, when there isn't.
   */
  for(repo?: string): GitHub | string {
    const all = [...this.boards.values()];
    if (!all.length) return "This floor has no repositories on GitHub — add one from the elevator";
    if (!repo) return all.length === 1 ? all[0] : 'Say which repository: this floor has several';
    return all.find((b) => !b.repo || sameRepo(b.repo, repo)) ?? `${repo} isn't one of this floor's repositories`;
  }

  async refresh() {
    await Promise.all([...this.boards.values()].map((b) => b.refresh()));
  }

  stop() {
    for (const b of this.boards.values()) b.stop();
  }

  /** A worker took issue `n` (in `repo`, on a team floor): see GitHub.claim. */
  claim(n: number, as: GhAs | undefined, repo?: string): Promise<string | undefined> {
    const board = this.for(repo);
    return typeof board === 'string' ? Promise.resolve(board) : board.claim(n, as);
  }

  private gatherIssues() {
    this.issues = gather([...this.boards.values()].map((b) => ({ repo: b.repo, state: b.issues })));
    this.onIssues(this.issues);
  }

  private gatherPulls() {
    this.pulls = gather([...this.boards.values()].map((b) => ({ repo: b.repo, state: b.pulls })));
    this.onPulls(this.pulls);
  }
}

function key(repo?: string): string {
  return repo?.toLowerCase() ?? '';
}

/**
 * Several boards' lists as one: everything on them, loading while any is, each one's error said with
 * its repository's name, and fetched as long ago as the stalest (so a stale one is asked again).
 */
export function gather<T>(lists: { repo?: string; state: GhState<T> }[]): GhState<T> {
  if (!lists.length) return EMPTY();
  if (lists.length === 1) return lists[0].state;
  const errors = lists.filter((l) => l.state.error).map((l) => `${l.repo ? `${repoName(l.repo)}: ` : ''}${l.state.error}`);
  return {
    items: lists.flatMap((l) => l.state.items),
    fetchedAt: Math.min(...lists.map((l) => l.state.fetchedAt)),
    loading: lists.some((l) => l.state.loading),
    ...(errors.length ? { error: errors.join(' · ') } : {}),
  };
}
