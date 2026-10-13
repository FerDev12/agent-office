// The building's floors: riding the elevator between them and up to the roof, adding and taking off
// floors, and a team floor's repositories.
import type { FloorClientMsg } from '../../../shared/protocol.js';
import { ROOF } from '../../../shared/rooftop.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { arrivalSpot, str } from '../../office/input.js';
import { MAX_TEAM_REPOS } from '../../team-floors.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const projectView: ViewPieces['project'] = (_ctx, floor) => floor?.project ?? null;

export const floorHandlers = {
  'floor.go'(ctx, c, msg) {
    if (msg.floor === ROOF) {
      if (ctx.floors.size) ctx.goToRoof(c);
      else ctx.warn(c, 'There is no building to go up on yet');
      return;
    }
    const floor = ctx.floors.get(str(msg.floor, 64));
    if (!floor) ctx.warn(c, ctx.building.pending().some((d) => d.id === msg.floor) ? "That floor is still being cloned — it'll be ready in a moment" : 'No such floor');
    else ctx.goToFloor(c, floor, arrivalSpot(msg.at));
  },
  'floor.repos'(ctx, c, msg) {
    void ctx.building.repos(msg.refresh === true).then(
      (repos) => ctx.sendTo(c, { t: 'floor.repos', repos }),
      (err: Error) => ctx.sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't list your repositories with gh: ${err.message}` }),
    );
  },
  'floor.add'(ctx, c, msg) {
    const who = c.peer.name;
    const repo = str(msg.repo, 200);
    void ctx.building
      .add(
        repo,
        who,
        (def) => {
          ctx.floorsChanged();
          ctx.toastAll(`🛗 ${who} is adding a floor for ${def.repo ?? def.name}…`);
        },
        c.accountId,
      )
      .then((r) => {
        ctx.floorsChanged();
        if (typeof r === 'string') return ctx.sendTo(c, { t: 'floor.added', repo, error: r });
        const floor = ctx.openFloor(r);
        if (!floor) return ctx.sendTo(c, { t: 'floor.added', repo, error: `Cloned ${r.repo}, but couldn't open its floor — see the office's log` });
        console.log(`  ${who} added a floor for ${r.repo} (${r.dir})`);
        ctx.toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
        ctx.sendTo(c, { t: 'floor.added', repo, floor: floor.id });
      });
  },
  'floor.create'(ctx, c, msg) {
    const who = c.peer.name;
    const name = str(msg.name, 200);
    const repos = Array.isArray(msg.repos) ? [...new Set(msg.repos.slice(0, MAX_TEAM_REPOS + 1).map((x) => str(x, 200)).filter(Boolean))] : [];
    if (repos.length > MAX_TEAM_REPOS) return ctx.sendTo(c, { t: 'floor.created', name, error: `A floor takes at most ${MAX_TEAM_REPOS} repositories` });
    const def = ctx.building.create(name, who);
    if (typeof def === 'string') return ctx.sendTo(c, { t: 'floor.created', name, error: def });
    const floor = ctx.openFloor(def);
    ctx.floorsChanged();
    if (!floor) return ctx.sendTo(c, { t: 'floor.created', name, error: `Made ${def.dir}, but couldn't open its floor — see the office's log` });
    console.log(`  ${who} made the ${def.name} team floor (${def.dir})`);
    ctx.toastAll(`🛗 New floor: ${def.name}, added by ${who}${repos.length ? ` — cloning ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} into it` : ''}`);
    ctx.sendTo(c, { t: 'floor.created', name, floor: floor.id });
    for (const repo of repos) addRepo(ctx, c, def.id, repo);
  },
  'floor.repo.add'(ctx, c, msg) {
    addRepo(ctx, c, str(msg.floor, 64), str(msg.repo, 200));
  },
  'floor.repo.remove'(ctx, c, msg) {
    const who = c.peer.name;
    // Everyone's work in it loses its boards: admins do it. A clone on its way, whoever added it can stop too.
    const id = str(msg.floor, 64);
    const r = ctx.building.removeRepo(id, str(msg.repo, 200), who, ctx.meOf(c.accountId).admin, (owner) => !!owner && owner === c.accountId);
    if (typeof r === 'string') return ctx.warn(c, r);
    ctx.floorsChanged();
    // A clone being stopped: whoever added it hears once it has (see addRepo).
    if (r.stopping) return ctx.toastAll(`🛗 ${who} stopped cloning ${r.repo.repo} into ${r.def.name}`);
    ctx.floors.get(id)?.reposChanged();
    console.log(`  ${who} took ${r.repo.repo} off the ${r.def.name} floor (${r.repo.path} stays where it is)`);
    ctx.toastAll(`🛗 ${who} took ${r.repo.repo} off ${r.def.name}`);
  },
  'floor.cancel'(ctx, c, msg) {
    const who = c.peer.name;
    const admin = ctx.meOf(c.accountId).admin;
    const id = str(msg.floor, 64);
    const def = ctx.building.pending().find((d) => d.id === id);
    const err = ctx.building.cancel(id, `${who} stopped the clone`, (owner) => admin || (!!owner && owner === c.accountId));
    if (err) ctx.warn(c, err);
    else ctx.toastAll(`🛗 ${who} stopped cloning ${def?.repo ?? def?.name ?? 'a floor'}`);
  },
  'floor.remove'(ctx, c, msg) {
    const who = c.peer.name;
    // Everyone's workers on it stop: admins do it.
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can take a floor off the building');
    const id = str(msg.floor, 64);
    const r = ctx.building.remove(id, who);
    if (typeof r === 'string') return ctx.warn(c, r);
    console.log(`  ${who} took the ${r.name} floor off the building (${r.dir} stays where it is)`);
    const floor = ctx.floors.get(id);
    if (floor) ctx.closeFloor(floor, who);
    else ctx.floorsChanged();
  },
  'floor.projectsDir'(ctx, c, msg) {
    const who = c.peer.name;
    // It's a folder on the office's machine that `gh` writes into: admins pick it.
    const err = ctx.meOf(c.accountId).admin ? ctx.building.setProjectsDir(str(msg.dir, 1024), who) : 'Only admins can move the workspace folder';
    ctx.warn(c, err);
    if (err) return;
    const state = ctx.building.projectsDirState();
    ctx.broadcast({ t: 'projectsDir', state });
    ctx.toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
  },
} satisfies HandlerMap<FloorClientMsg>;

/** Clones `repo` into the team floor `id` for `c`: everyone hears once it's there, and `c` why when it isn't. */
function addRepo(ctx: Ctx, c: Client, id: string, repo: string) {
  const who = c.peer.name;
  void ctx.building.addRepo(id, repo, who, () => ctx.floorsChanged(), c.accountId).then((r) => {
    ctx.floorsChanged();
    if (typeof r === 'string') return ctx.warn(c, `🛗 ${r}`);
    ctx.floors.get(id)?.reposChanged();
    console.log(`  ${who} added ${r.repo.repo} to the ${r.def.name} floor (${r.repo.path})`);
    ctx.toastAll(`🛗 ${r.repo.repo} is on ${r.def.name} now, added by ${who}`);
  });
}
