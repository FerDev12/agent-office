// Workers at their desks and the board agents at their kiosks: hiring them, their terminals, their
// worktrees and pull requests.
import path from 'node:path';
import { MAX_REPOS, type RepoSource } from '../../workers.js';
import { OPEN_CODE_MODEL_MAX } from '../../../shared/providers.js';
import { isAgentEffort, isAgentProvider, type WorkerClientMsg } from '../../../shared/protocol.js';
import { ghRef, normalizeRepo, parseTeamRepoKey, repoName } from '../../../shared/floors.js';
import type { Ctx } from '../../office/context.js';
import { MAX_TEAM_REPOS } from '../../team-floors.js';
import type { Floor } from '../../floor.js';
import { issueNumber, num, str } from '../../office/input.js';
import { here, workerOf } from './common.js';
import type { FeatureHooks, HandlerMap, ViewPieces } from './types.js';

const CLEANUPS = new Set(['keep', 'worktree', 'all']);

export const workersView: ViewPieces['workers'] = (_ctx, floor) => floor?.workers.list() ?? [];
export const jailView: ViewPieces['jail'] = (_ctx, floor) => floor?.jail.state() ?? { prisoners: [], bones: 0 };

/** The least time between two 'term.typing' notes from one person in one terminal. */
const TYPING_GAP_MS = 500;

export const workerHandlers = {
  'worker.spawn'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    if (!floor) return;
    const kind = msg.kind === 'shell' ? 'shell' : 'agent';
    if (kind === 'agent' && msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
      ctx.warn(c, 'Unknown agent provider');
      return;
    }
    const model = msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1);
    const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
    // The repositories to work in, each in a worktree of its own.
    // Its own team floor's repositories (up to MAX_TEAM_REPOS) and other projects (up to MAX_REPOS, which spawn checks).
    const repos = repoSources(ctx, floor, Array.isArray(msg.repos) ? [...new Set(msg.repos.slice(0, MAX_REPOS + MAX_TEAM_REPOS + 1).map((x) => str(x, 140)))] : []);
    if (typeof repos === 'string') return ctx.warn(c, repos);
    // A shell is theirs too: `claude auth login` or `gh auth login` typed there signs them in.
    const hire = () => {
      const r = floor.workers.spawn(str(msg.deskId, 32), who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, msg.provider, model, effort, undefined, c.accountId, repos, msg.via === 'herald' ? 'herald' : undefined);
      if (typeof r === 'string') return ctx.warn(c, r);
      const issue = kind === 'agent' ? issueNumber(msg.issue) : undefined;
      const issueRepo = issue ? normalizeRepo(msg.issueRepo) : undefined;
      // Across repositories: its first (the floor's project, or one of a team floor's repositories) and the others.
      const across = r.repos?.length ? ` across ${[r.worktree?.repo ? repoName(r.worktree.repo) : floor.def.name, ...r.repos.map((x) => x.name)].join(' + ')}` : '';
      ctx.toastFloor(floor, kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${issue ? ` for issue ${ghRef(issue, issueRepo)}` : r.prompt ? ' with a task' : ''}${across}`);
      if (issue) ctx.takeIssue(c, floor, issue, issueRepo);
    };
    // Every project it gets a worktree of starts from what's on GitHub.
    const fresh = [floor, ...repos.flatMap((x) => (x.floor === floor.id ? [] : [ctx.floors.get(x.floor)!]))];
    ctx.withSignIn(c, kind === 'agent' ? ctx.claudeFor(msg.provider ?? floor.workers.officeDefault.provider) : undefined, () => (msg.worktree === true ? ctx.withFreshBase(c, fresh, hire) : hire()));
  },
  'worker.resume'(ctx, c, msg) {
    const w = workerOf(ctx, msg.workerId);
    ctx.warn(c, w ? w.floor.workers.resume(w.wid) : 'No such worker');
  },
  'worker.kill'(ctx, c, msg) {
    const who = c.peer.name;
    const w = workerOf(ctx, msg.workerId);
    if (!w) return;
    const { floor, info } = w;
    // The worker leaves right away; its worktree is dealt with after that, and the outcome follows.
    const done = floor.sendHome(info.id, CLEANUPS.has(String(msg.cleanup)) ? msg.cleanup : undefined);
    ctx.toastFloor(floor, `${who} sent ${info.name} home`);
    void done.then(({ note, error }) => {
      if (note) ctx.toastFloor(floor, note);
      if (error) ctx.toastFloor(floor, error, 'warn');
    });
  },
  'worker.worktree'(ctx, c, msg) {
    const w = workerOf(ctx, msg.workerId);
    if (!w) return;
    void w.floor.workers.inspectWorktree(w.wid).then((state) => {
      if (state) ctx.sendTo(c, { t: 'worker.worktree', workerId: w.wid, state });
    });
  },
  'worker.rebuild'(ctx, c, msg) {
    const who = c.peer.name;
    const w = workerOf(ctx, msg.workerId);
    if (!w) return;
    const { floor } = w;
    // With `all`, every worker on the floor whose worktree was deleted, this one first.
    const ids = [w.wid, ...(msg.all === true ? floor.workers.list().filter((x) => x.lost && x.id !== w.wid).map((x) => x.id) : [])];
    void (async () => {
      const names: string[] = [];
      const notes: string[] = [];
      for (const id of ids) {
        const info = floor.workers.get(id);
        // Sent home meanwhile, or back already with one before it (the rest of a meeting's table).
        if (!info || (id !== w.wid && !info.lost)) continue;
        const r = await floor.workers.rebuild(id);
        if (r.error) ctx.warn(c, r.error);
        else if (!r.rebuilt) ctx.sendTo(c, { t: 'toast', text: r.note ?? `${info.name}'s worktree is already there`, level: 'info' });
        else {
          names.push(info.name);
          if (r.note) notes.push(r.note);
        }
      }
      if (!names.length) return;
      const whose = names.length === 1 ? `${names[0]}'s worktree` : `the worktrees of ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      ctx.toastFloor(floor, `🌿 ${who} rebuilt ${whose}${notes.length ? ` — ${notes.join('; ')}` : ''}`);
    })();
  },
  'worker.attach'(ctx, c, msg) {
    const who = c.peer.name;
    const w = workerOf(ctx, msg.workerId);
    const snap = w?.floor.workers.attach(w.wid, c.id, who);
    if (w && snap) {
      c.attached.add(w.wid);
      ctx.sendTo(c, { t: 'term.snapshot', workerId: w.wid, ...snap });
    }
  },
  'worker.detach'(ctx, c, msg) {
    const wid = str(msg.workerId, 32);
    c.attached.delete(wid);
    c.typingAt.delete(wid);
    ctx.workerFloor(wid)?.workers.detach(wid, c.id);
  },
  'worker.prompt'(ctx, c, msg) {
    const who = c.peer.name;
    const w = workerOf(ctx, msg.workerId);
    const err = w ? w.floor.workers.prompt(w.wid, str(msg.prompt, 20000), who) : 'No such worker';
    ctx.warn(c, err);
    const issue = w?.info.kind === 'agent' ? issueNumber(msg.issue) : undefined;
    if (w && !err && issue) {
      const repo = normalizeRepo(msg.issueRepo);
      ctx.toastFloor(w.floor, `${who} handed issue ${ghRef(issue, repo)} to ${w.info.name}`);
      ctx.takeIssue(c, w.floor, issue, repo);
    }
  },
  'station.prompt'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    if (!floor) return;
    const deskId = str(msg.deskId, 32);
    // Nobody there yet: whoever asks first hires it, on their own sign-ins.
    const hires = !floor.workers.deskOccupied(deskId);
    ctx.withSignIn(c, hires ? ctx.claudeFor(floor.workers.officeDefault.provider) : undefined, () => {
      const r = floor.workers.station(deskId, who, str(msg.prompt, 20000), c.accountId);
      if (typeof r === 'string') ctx.warn(c, r);
      else if (r.hired) ctx.toastFloor(floor, `${who} asked the ${r.info.name} something`);
    });
  },
  'worker.pr'(ctx, c, msg) {
    const who = c.peer.name;
    const w = workerOf(ctx, msg.workerId);
    if (!w) return;
    const { floor, wid } = w;
    ctx.withGitHub(c, (as) => void floor.workers.openPr(wid, who, as).then((r) => {
      if (typeof r === 'string') return ctx.warn(c, r);
      const info = floor.workers.get(wid);
      const name = info?.name ?? 'the worker';
      const [one] = r.prs;
      if (r.prs.length === 1 && !one.repo) ctx.toastFloor(floor, one.existed ? `${name}'s branch already has PR #${one.number}` : `${who} opened PR #${one.number} for ${name}`);
      else {
        // Across repositories: one line for them all.
        const list = r.prs.map((p) => `${p.repo} #${p.number}`).join(', ');
        ctx.toastFloor(floor, r.prs.every((p) => p.existed) ? `${name}'s pull requests are already open: ${list}` : `${who} opened ${name}'s pull requests: ${list}`);
      }
      const dirty = r.prs.filter((p) => p.dirty);
      if (dirty.length) ctx.warn(c, `${name} still has uncommitted changes in ${dirty.some((p) => p.repo) ? `its worktree${dirty.length > 1 ? 's' : ''} of ${dirty.map((p) => p.repo).join(', ')}` : 'its worktree'} — they are not in the PR`);
      for (const f of r.failed) ctx.warn(c, f);
      // Put it on the board now rather than at the next poll. A refresh already in flight
      // returns at once and can miss it, so look again shortly after.
      const own = r.prs.find((p) => !p.repo || p.repo === info?.worktree?.path.split(/[\\/]/).pop());
      void floor.github.refresh().then(() => {
        if (own && !floor.github.pulls.items.some((p) => p.url === own.url || (!p.repo && p.number === own.number))) setTimeout(() => void floor.github.refresh(), 3000);
      });
      for (const x of info?.repos ?? []) if (x.floor !== floor.id) void ctx.floors.get(x.floor)?.github.refresh();
    }));
  },
  'term.input'(ctx, c, msg) {
    const who = c.peer.name;
    if (c.attached.has(msg.workerId)) ctx.workerFloor(msg.workerId)?.workers.write(msg.workerId, str(msg.data, 64 * 1024), who);
  },
  'term.typing'(ctx, c, msg) {
    // Everyone else in that terminal sees who's typing. A typist says so about once a second.
    const w = workerOf(ctx, msg.workerId);
    const now = Date.now();
    if (!w || !c.attached.has(w.wid) || now - (c.typingAt.get(w.wid) ?? 0) < TYPING_GAP_MS) return;
    c.typingAt.set(w.wid, now);
    for (const id of w.info.viewerIds) {
      const o = ctx.clients.get(id);
      if (o && o.id !== c.id) ctx.sendTo(o, { t: 'term.typing', workerId: w.wid, id: c.id });
    }
  },
  'term.resize'(ctx, c, msg) {
    if (c.attached.has(msg.workerId)) ctx.workerFloor(msg.workerId)?.workers.resize(msg.workerId, num(msg.cols), num(msg.rows));
  },
} satisfies HandlerMap<WorkerClientMsg>;

export const workerHooks: FeatureHooks = {
  leaving(_ctx, c, was) {
    if (was) was.workers.detachAll(c.id);
    c.attached.clear();
    c.typingAt.clear();
    c.stale.clear();
  },
  closedOn: (_ctx, c, floor) => floor.workers.detachAll(c.id),
};

/**
 * The repositories a hire names (see worker.spawn's `repos`): another floor's id for its project, or
 * `<floor>/<folder>` for one of a team floor's repositories, maybe one of `floor`'s own. Why not, when
 * one of them isn't (any more).
 */
function repoSources(ctx: Ctx, floor: Floor, keys: string[]): RepoSource[] | string {
  const repos: RepoSource[] = [];
  for (const key of keys) {
    const team = parseTeamRepoKey(key);
    const other = ctx.floors.get(team?.floor ?? key);
    if (!other) return 'That project is no longer in the building';
    if (!team) {
      if (other === floor) return "The worker's own floor's project is already in its workspace";
      if (other.def.team) return `${other.def.name} is a team floor: pick its repositories one by one`;
      repos.push({ floor: other.id, name: other.def.name, repo: other.def.repo, dir: other.dir });
      continue;
    }
    const r = other.def.repos?.find((x) => x.path === team.path);
    if (!r) return `${team.path} is no longer one of ${other.def.name}'s repositories`;
    repos.push({ floor: other.id, name: repoName(r.repo), repo: r.repo, dir: path.join(other.dir, r.path), ...(other === floor ? { checkout: r.path } : {}) });
  }
  return repos;
}
