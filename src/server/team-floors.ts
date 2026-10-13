// Team floors: a floor that's a folder of its own rather than one repository's checkout, for a team
// that works across several repositories, or in none. Its repositories are cloned into it, one folder
// each, and its workers start in it with all of them to hand. This is the cloning of those
// repositories (watched like a floor's own clone, and carried on through a restart of the office),
// the folders they get, and the brief the floor's agents read there.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo, repoName, sameRepo } from '../shared/floors.js';
import type { FloorRepo } from '../shared/protocol.js';
import type { FloorDef } from './building.js';
import { checkoutAt, cloneHere } from './checkouts.js';
import { CloneRun, dropLog, whyCloneFailed, type CloneEnd, type CloneRunOptions } from './clone.js';
import { gh } from './github.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { WORKSPACE_FILES } from './worktrees.js';

/** Where team floors' folders go, in the projects folder. GitHub owners can't have an underscore, so no clone ever lands in it. */
export const TEAM_FLOORS_DIR = '_floors';
/** The most repositories one team floor has. */
export const MAX_TEAM_REPOS = 12;
/** The first line of a brief the office wrote, so it knows it may write it again; a brief without it is the team's own. */
const BRIEF_MARK = "<!-- Written by Agent Office for this team floor, and rewritten when its repositories change. Delete this line to keep your own edits. -->";

/** One of a team floor's repositories, as floors.json keeps it (FloorDef.repos). */
export interface FloorRepoDef {
  /** owner/name on GitHub. */
  repo: string;
  /** Its checkout's folder in the floor's folder. */
  path: string;
  addedBy: string;
  addedAt: number;
}

/** A repository on its way into a team floor. */
interface Pending {
  floor: string;
  def: FloorRepoDef;
  run?: CloneRun;
  /** The account that added it. */
  owner?: string;
  /** GitHub says it has no commits yet, so there's nothing to check out. */
  empty: boolean;
}

/** A clone under way, as team-clones.json keeps it for the next office to pick up. */
interface Saved extends FloorRepoDef {
  floor: string;
  pid: number;
  log: string;
  owner?: string;
  empty?: boolean;
}

export interface TeamReposOptions {
  /** Clones run in this terminal (see BuildingOptions.terminal). */
  terminal?: boolean;
  clone?: Pick<CloneRunOptions, 'stallMs' | 'tickMs'>;
  /** Hears whenever a clone gets further along. */
  changed(): void;
}

/** The repositories being cloned into team floors (see FloorDef.team), and adding and taking them off. */
export class TeamRepos {
  /** By floor id and lower-cased owner/name. */
  private pending = new Map<string, Pending>();
  /** Floors taken off the building (their id may come back as another's): a repository still on its way there doesn't join it. */
  private dropped = new WeakSet<FloorDef>();
  private file: string;

  constructor(
    /** The office's own data folder; `gh` runs there. */
    private dataDir: string,
    /** Where clones write their progress. */
    private logsDir: string,
    private opts: TeamReposOptions,
  ) {
    this.file = path.join(dataDir, 'team-clones.json');
  }

  /** A team floor's repositories for the elevator: the ones there, then the ones on their way. */
  list(def: FloorDef): FloorRepo[] {
    return [
      ...(def.repos ?? []).map((r) => ({ repo: r.repo, path: r.path })),
      ...[...this.pending.values()].filter((p) => p.floor === def.id).map((p) => ({ repo: p.def.repo, path: p.def.path, cloning: true, ...(p.run?.progress ? { clone: p.run.progress } : {}) })),
    ];
  }

  /**
   * Clones `input` into the team floor `def`'s folder. Resolves to the repository once it's there, put
   * on `def.repos` and `save`d, or to why it isn't. `started` hears as soon as it's on its way, and
   * `account` (whoever's adding it) can stop it, as admins can.
   */
  async add(def: FloorDef, input: string, by: string, save: () => void, started: () => void, account?: string): Promise<FloorRepoDef | string> {
    const wanted = normalizeRepo(input);
    if (!wanted) return 'Pick a repository, or type it as owner/name';
    const taken = (repo: string) => this.has(def, repo) && `${repo} is already on ${def.name}`;
    const full = () => this.count(def) >= MAX_TEAM_REPOS && `${def.name} has ${MAX_TEAM_REPOS} repositories already, as many as a floor takes`;
    const early = taken(wanted) || full();
    if (early) return early;
    let repo: string;
    let empty = false;
    try {
      const view = JSON.parse(await gh(['repo', 'view', wanted, '--json', 'nameWithOwner,isEmpty'], this.dataDir, 30_000)) as { nameWithOwner?: string; isEmpty?: boolean };
      repo = normalizeRepo(view.nameWithOwner) ?? wanted;
      empty = view.isEmpty === true;
    } catch (err) {
      return `Couldn't find ${wanted} on GitHub: ${(err as Error).message}`;
    }
    const late = this.dropped.has(def) ? 'The floor was taken off the building' : taken(repo) || full();
    if (late) return late;
    const folder = this.folderFor(def, repo, empty);
    if (!folder) return `There's no folder free for ${repo} in ${def.dir}`;
    const pending: Pending = { floor: def.id, def: { repo, path: folder, addedBy: by, addedAt: Date.now() }, owner: account, empty };
    this.pending.set(key(def.id, repo), pending);
    started();
    try {
      const err = await this.clone(def, pending);
      if (err) return err;
    } finally {
      this.pending.delete(key(def.id, repo));
      this.save();
    }
    if (this.dropped.has(def)) return 'The floor was taken off the building';
    def.repos = [...(def.repos ?? []), pending.def];
    save();
    return pending.def;
  }

  /**
   * Takes `input` off the team floor `def` (and `save`s), or stops its clone (`stopping`: whoever added
   * it hears once it has). Its checkout stays in the floor's folder: adding it again moves back in.
   * Returns it, or why it can't.
   */
  remove(def: FloorDef, input: string, by: string, save: () => void): { repo: FloorRepoDef; stopping?: true } | string {
    const repo = normalizeRepo(input);
    const on = repo && def.repos?.find((r) => sameRepo(r.repo, repo));
    if (on) {
      def.repos = def.repos!.filter((r) => r !== on);
      save();
      return { repo: on };
    }
    const p = repo && this.pending.get(key(def.id, repo));
    if (!p) return `${input} isn't one of ${def.name}'s repositories`;
    if (!p.run) return "There's no clone to stop yet — try again in a moment";
    p.run.stop(`${by} stopped the clone`);
    return { repo: p.def, stopping: true };
  }

  /** Every repository on its way into the floor `def`: stopped, since the floor is going. */
  drop(def: FloorDef) {
    this.dropped.add(def);
    for (const p of this.pending.values()) if (p.floor === def.id) p.run?.stop('The floor was taken off the building');
  }

  /**
   * Picks up the clones an office before this one left running: each carries on, and `done` hears how
   * it ended, once it's on its floor's list (and `save`d), or why not.
   */
  resume(floorOf: (id: string) => FloorDef | undefined, save: () => void, done: (def: FloorDef, r: FloorRepoDef | string) => void) {
    for (const s of this.load()) {
      const def = floorOf(s.floor);
      const repo = normalizeRepo(s.repo);
      if (!def?.team || !repo || this.has(def, repo)) {
        dropLog(s.log);
        continue;
      }
      const pending: Pending = { floor: def.id, def: { repo, path: s.path, addedBy: s.addedBy, addedAt: s.addedAt }, owner: s.owner, empty: !!s.empty };
      const settled = (err: string | undefined) => {
        if (err) return done(def, err);
        def.repos = [...(def.repos ?? []), pending.def];
        save();
        done(def, pending.def);
      };
      const run = CloneRun.adopt(s.pid, s.log, { ...this.opts.clone, changed: () => this.opts.changed() });
      if (!run) {
        dropLog(s.log);
        settled(checkoutAt(path.join(def.dir, s.path), repo, pending.empty) === 'ok' ? undefined : `Cloning ${repo} into ${def.name} stopped when the office restarted — add it again`);
        continue;
      }
      pending.run = run;
      this.pending.set(key(def.id, repo), pending);
      void run.done.then((end) => {
        const err = this.settle(def, pending, end);
        this.pending.delete(key(def.id, repo));
        this.save();
        settled(err);
      });
    }
    this.save();
  }

  /** The office is closing: its clones stop, or with `keep` (a restart) carry on for the next office to pick up. */
  shutdown(keep: boolean) {
    for (const p of this.pending.values()) {
      if (keep) p.run?.release();
      else p.run?.stop('The office closed before the clone finished');
    }
    if (keep) return;
    this.pending.clear();
    this.save();
  }

  private has(def: FloorDef, repo: string): boolean {
    return !!def.repos?.some((r) => sameRepo(r.repo, repo)) || this.pending.has(key(def.id, repo));
  }

  private count(def: FloorDef): number {
    return (def.repos?.length ?? 0) + [...this.pending.values()].filter((p) => p.floor === def.id).length;
  }

  /**
   * The folder `repo` gets in the floor's: its name ("api"), else owner-name, else with -2, -3…: one
   * nothing else on the floor has, and that's empty or already a checkout of it (added before, then
   * taken off again).
   */
  private folderFor(def: FloorDef, repo: string, empty: boolean): string | undefined {
    const used = new Set([...(def.repos ?? []).map((r) => r.path), ...[...this.pending.values()].filter((p) => p.floor === def.id).map((p) => p.def.path)].map((p) => p.toLowerCase()));
    const safe = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'repo';
    const bases = [safe(repoName(repo)), safe(repo.replace('/', '-'))];
    for (let n = 1; n <= 20; n++) {
      for (const base of n === 1 ? bases : [bases[1]]) {
        const name = n === 1 ? base : `${base}-${n}`;
        if (used.has(name.toLowerCase()) || WORKSPACE_FILES.has(name) || name === '.agent-office') continue;
        const there = checkoutAt(path.join(def.dir, name), repo, empty);
        if (there === 'none' || there === 'ok') return name;
      }
    }
    return undefined;
  }

  /** Clones a repository on its way, or checks that what's already in its folder is it. Resolves to an error, if any. */
  private async clone(def: FloorDef, p: Pending): Promise<string | undefined> {
    const dest = path.join(def.dir, p.def.path);
    if (checkoutAt(dest, p.def.repo, p.empty) === 'ok') return undefined;
    if (this.opts.terminal) return cloneHere(p.def.repo, dest);
    try {
      mkdirSync(this.logsDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return `Couldn't make ${this.logsDir}: ${(err as Error).message}`;
    }
    const log = path.join(this.logsDir, `${def.id}__${p.def.repo.replace('/', '__')}.log`);
    const run = await CloneRun.start(p.def.repo, dest, log, { ...this.opts.clone, changed: () => this.opts.changed() });
    if (typeof run === 'string') return run;
    p.run = run;
    this.save();
    return this.settle(def, p, await run.done);
  }

  /** Whether a clone that ended left its checkout: an error if it didn't. */
  private settle(def: FloorDef, p: Pending, end: CloneEnd): string | undefined {
    if (p.run) dropLog(p.run.log);
    if (end.stopped) return end.stopped;
    if (checkoutAt(path.join(def.dir, p.def.path), p.def.repo, p.empty) === 'ok') return undefined;
    return `Couldn't clone ${p.def.repo}: ${whyCloneFailed(end.output)}`;
  }

  private load(): Saved[] {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>[];
      return (Array.isArray(saved) ? saved : []).filter(
        (s): s is Saved =>
          Number.isInteger(s.pid) && (s.pid as number) > 0 && typeof s.log === 'string' && path.dirname(s.log) === this.logsDir && typeof s.floor === 'string' && typeof s.repo === 'string' && typeof s.path === 'string' && !!s.path && !/[\\/]|^\.\.?$/.test(s.path),
      );
    } catch {
      return [];
    }
  }

  private save() {
    const saved: Saved[] = [...this.pending.values()].flatMap((p) => (p.run ? [{ ...p.def, floor: p.floor, pid: p.run.pid, log: p.run.log, owner: p.owner, empty: p.empty }] : []));
    try {
      if (saved.length) writeFileSync(this.file, JSON.stringify(saved, null, 2), { mode: 0o600 });
      else rmSync(this.file, { force: true });
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}

function key(floor: string, repo: string): string {
  return `${floor}\0${repo.toLowerCase()}`;
}

/** The repositories floors.json kept for a team floor: each one's owner/name and a plain folder name. */
export function validTeamRepos(raw: unknown): FloorRepoDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((r): FloorRepoDef[] => {
    const repo = normalizeRepo(r?.repo);
    const folder = typeof r?.path === 'string' ? r.path : '';
    if (!repo || !folder || /[\\/]|^\.\.?$/.test(folder) || seen.has(repo.toLowerCase())) return [];
    seen.add(repo.toLowerCase());
    return [{ repo, path: folder, addedBy: typeof r.addedBy === 'string' ? r.addedBy : '?', addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now() }];
  });
}

/**
 * Writes the team floor brief (the 'floor.team' prompt) into its folder as CLAUDE.md and AGENTS.md,
 * for every agent that starts there: which folder is which repository. A file the team wrote itself
 * (without the office's first line) is left alone; with no repositories, the office's own goes.
 */
export function writeTeamBrief(dir: string, name: string, repos: FloorRepoDef[], prompts?: PromptSource) {
  const text = repos.length
    ? `${BRIEF_MARK}\n\n${officePrompt(prompts, 'floor.team', { floor: name, repos: repos.map((r) => `- \`${r.path}/\`: ${r.repo}`).join('\n') }).trim()}\n`
    : undefined;
  for (const file of WORKSPACE_FILES) {
    const at = path.join(dir, file);
    try {
      if (existsSync(at) && !readFileSync(at, 'utf8').startsWith(BRIEF_MARK)) continue;
      if (text) writeFileSync(at, text);
      else rmSync(at, { force: true });
    } catch (err) {
      console.error(`agent-office: couldn't write ${at}: ${(err as Error).message}`);
    }
  }
}
