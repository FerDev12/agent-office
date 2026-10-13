import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Boards, gather } from '../src/server/boards.js';
import { Building } from '../src/server/building.js';
import { excludeFromGit } from '../src/server/config.js';
import { MergeWatch } from '../src/server/github.js';
import { landedWorkers } from '../src/server/leave-on-merge.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import { validTeamRepos, writeTeamBrief } from '../src/server/team-floors.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type RepoSource, type WorkerEvents } from '../src/server/workers.js';
import { ghRef, parseTeamRepoKey, repoOfUrl, sameGh, teamRepoKey } from '../src/shared/floors.js';
import type { GhIssue, GhPull, GhState, QueueTask, WorkerInfo } from '../src/shared/protocol.js';
import { workerPr } from '../src/shared/status.js';

// Team floors (FloorInfo.team): a floor that's a folder of its own with a checkout of each of its
// repositories in it, or none. Its boards show every repository's issues and pull requests, each
// known by its number and its repository, and its workers' worktrees are of its repositories.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const pull = (number: number, repo: string | undefined, state: string, headRefName: string, more: Partial<GhPull> = {}): GhPull => ({
  number, repo, title: `PR ${number}`, state, isDraft: false, url: repo ? `https://github.com/${repo}/pull/${number}` : '', author: '', labels: [], reviewDecision: '',
  headRefName, baseRefName: 'main', createdAt: '2026-01-01T00:00:00Z', updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [], ...more,
});

function worker(id: string, more: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, kind: 'agent', deskId: 'desk-1', name: id, color: '#fff', status: 'done', acked: false, createdBy: 'test', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...more };
}

// ---- What both sides share ---------------------------------------------------------------------

test("a team floor's repository is named by its floor and folder, and an issue by its number and repository", () => {
  assert.equal(teamRepoKey('payments', 'api'), 'payments/api');
  assert.deepEqual(parseTeamRepoKey('payments/api'), { floor: 'payments', path: 'api' });
  assert.equal(parseTeamRepoKey('payments'), undefined, 'a plain floor id');
  assert.equal(ghRef(12), '#12');
  assert.equal(ghRef(12, 'acme/api'), 'api#12');
  assert.equal(repoOfUrl('https://github.com/acme/api/pull/7'), 'acme/api');
  assert.equal(repoOfUrl('https://github.com/acme/api/issues/7'), 'acme/api');
  assert.equal(repoOfUrl(undefined), undefined);
  assert.ok(sameGh({ number: 12 }, 12), 'one repository: the number says');
  assert.ok(sameGh({ number: 12, repo: 'acme/api' }, 12, 'ACME/api'));
  assert.ok(!sameGh({ number: 12, repo: 'acme/api' }, 12, 'acme/web'));
});

test("on a team floor a worker's pull request is known by its repository, though numbers repeat", () => {
  const pulls = [pull(7, 'acme/api', 'MERGED', 'fix-api'), pull(7, 'acme/web', 'OPEN', 'other'), pull(8, 'acme/web', 'OPEN', 'office/cody')];
  // Its own, said by URL: api's #7 merged, whatever web's #7 is doing.
  const own = worker('cody', { pr: { number: 7, url: 'https://github.com/acme/api/pull/7' } });
  assert.deepEqual(workerPr(own, pulls, []), { state: 'merged', number: 7, repo: 'acme/api' });
  // Its worktree is of api: web's pull request from a branch of the same name isn't its.
  const tree = worker('cody', { worktree: { path: 'x', branch: 'office/cody', base: 'abc', checkout: 'api', repo: 'acme/api' } });
  assert.equal(workerPr(tree, pulls, []), undefined);
  // …and one of web's is, when its worktree is of web.
  const web = worker('cody', { worktree: { path: 'x', branch: 'office/cody', base: 'abc', checkout: 'web', repo: 'acme/web' } });
  assert.deepEqual(workerPr(web, pulls, []), { state: 'open', number: 8, repo: 'acme/web' });
  // A project's own floor is as it always was: no repositories on its list, numbers say.
  const plain = [pull(7, undefined, 'MERGED', 'fix')];
  assert.deepEqual(workerPr(worker('cody', { pr: { number: 7, url: 'whatever' } }), plain, []), { state: 'merged', number: 7 });
});

test("a worker across a team floor's repositories goes home once each one's pull request merged", () => {
  const branch = 'office/cody';
  const w = worker('cody', {
    worktree: { path: '.agent-office/worktrees/cody/web', branch, base: 'abc', checkout: 'web', repo: 'acme/web' },
    repos: [{ floor: 'payments', name: 'api', repo: 'acme/api', dir: '/x/api', path: '.agent-office/worktrees/cody/api', branch, base: 'def' }],
  });
  const both = (api: string) => [pull(3, 'acme/web', 'MERGED', branch, { headRefOid: 'w1' }), pull(3, 'acme/api', api, branch, { headRefOid: 'a1' })];
  const pullsOf = (pulls: GhPull[]) => (floor: string) => (floor === 'payments' ? pulls : undefined);
  assert.deepEqual(landedWorkers([w], both('OPEN'), [], pullsOf(both('OPEN'))), [], "api's is still open");
  const [landed] = landedWorkers([w], both('MERGED'), [], pullsOf(both('MERGED')));
  assert.equal(landed?.head, 'w1');
  // Each repository's head, by its name in the workspace (a team floor's all share one floor).
  assert.deepEqual(landed?.heads, { api: 'a1' });
});

test('the gong rings once for each repository whose pull request merged, though their numbers match', () => {
  const watch = new MergeWatch();
  watch.look([pull(5, 'acme/api', 'OPEN', 'a'), pull(5, 'acme/web', 'OPEN', 'b')]);
  assert.ok(watch.ring(5, 'acme/api'), 'merged from the PR window');
  const rung = watch.look([pull(5, 'acme/api', 'MERGED', 'a'), pull(5, 'acme/web', 'MERGED', 'b')]);
  assert.deepEqual(rung.map((p) => p.repo), ['acme/web']);
});

// ---- The boards --------------------------------------------------------------------------------

/** gh as two repositories' checkouts would answer: an issue #1 in each, and nothing else. */
const twoRepos = async (args: string[], cwd: string): Promise<string> => {
  const name = path.basename(cwd);
  if (args[0] === 'issue' && args[1] === 'list') return args.includes('open') ? JSON.stringify([{ number: 1, title: `${name} bug`, state: 'OPEN', url: `https://github.com/acme/${name}/issues/1`, author: { login: 'a' }, labels: [], assignees: [], createdAt: '', updatedAt: '', body: '', comments: [] }]) : '[]';
  if (args[0] === 'pr' && args[1] === 'list') return '[]';
  if (args[0] === 'issue' && args[1] === 'edit') return '';
  throw new Error(`unexpected gh ${args.join(' ')} in ${cwd}`);
};

test("a team floor's boards put every repository's issues together, each saying which it's in", async () => {
  let issues: GhState<GhIssue> | undefined;
  const boards = new Boards((s) => (issues = s), () => {}, twoRepos);
  await boards.set([{ repo: 'acme/api', dir: '/x/api' }, { repo: 'acme/web', dir: '/x/web' }]);
  assert.deepEqual(issues?.items.map((i) => [i.repo, i.number, i.title]), [['acme/api', 1, 'api bug'], ['acme/web', 1, 'web bug']]);
  assert.deepEqual(boards.repos(), ['acme/api', 'acme/web']);
  // Which board an action goes to: the one named; with several, one has to be.
  assert.match(String(boards.for()), /several/);
  assert.equal((boards.for('ACME/web') as { repo?: string }).repo, 'acme/web');
  assert.match(String(boards.for('acme/other')), /isn't one of this floor's/);
  // A repository taken off the floor takes its cards with it.
  await boards.set([{ repo: 'acme/web', dir: '/x/web' }]);
  assert.deepEqual(issues?.items.map((i) => i.repo), ['acme/web']);
  // None at all: nothing to show, and nothing to act on.
  await boards.set([]);
  assert.deepEqual(issues?.items, []);
  assert.match(String(boards.for('acme/web')), /no repositories/);
  boards.stop();
});

test("a project's floor has one board, untouched: no repository on its cards, and every action about its own goes to it", async () => {
  let issues: GhState<GhIssue> | undefined;
  const boards = new Boards((s) => (issues = s), () => {}, twoRepos);
  await boards.set([{ dir: '/x/app', home: 'acme/app' }]);
  assert.deepEqual(issues?.items.map((i) => [i.repo, i.number]), [[undefined, 1]]);
  assert.ok(typeof boards.for() !== 'string');
  assert.ok(typeof boards.for('ACME/app') !== 'string');
  // An issue in another repository (office-queue add --issue other/lib#12) isn't this one's #12.
  assert.match(String(boards.for('other/lib')), /isn't this floor's repository/);
  // A checkout that isn't on GitHub can't tell, so it takes them.
  await boards.set([{ dir: '/x/app' }]);
  assert.ok(typeof boards.for('other/lib') !== 'string');
  boards.stop();
});

test('lists put together say each one\'s error with its repository, and are as fresh as the stalest', () => {
  const st = (fetchedAt: number, error?: string): GhState<number> => ({ items: [fetchedAt], fetchedAt, loading: false, error });
  const both = gather([{ repo: 'acme/api', state: st(10, 'gh broke') }, { repo: 'acme/web', state: st(20) }]);
  assert.deepEqual(both, { items: [10, 20], fetchedAt: 10, loading: false, error: 'api: gh broke' });
});

// ---- The queue ---------------------------------------------------------------------------------

test('a team floor queues the same issue number from two repositories, and a task works in its own', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-team-queue-'));
  const spawned: { repos?: RepoSource[] }[] = [];
  const workers: WorkerInfo[] = [];
  const team: RepoSource[] = ['api', 'web'].map((n) => ({ floor: 'payments', name: n, repo: `acme/${n}`, dir: `/x/${n}`, checkout: n }));
  const manager: QueueWorkers = {
    defaultProvider: 'claude',
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, worktree, kind, provider, model, effort, meeting, owner, repos) {
      spawned.push({ repos });
      const w = worker(`w${workers.length}`, { deskId, status: 'working', worktree: { path: 'x', branch: `office/w${workers.length}`, base: 'abc' } });
      workers.push(w);
      return w;
    },
    kill: () => Promise.resolve({}),
    team: () => team,
  };
  const claimed: string[] = [];
  const queue = new TaskQueue(dir, manager, true, {
    update() {}, toast() {}, claimIssue: async (n, _o, repo) => void claimed.push(ghRef(n, repo)), refreshGitHub() {}, hiringPaused: () => undefined, emptied() {},
  });
  t.after(() => {
    queue.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  queue.setLimit(0);
  assert.equal(queue.add('fix api', 'ann', 'api #12', 12, undefined, undefined, undefined, undefined, 'acme/api'), undefined);
  assert.equal(queue.add('fix web', 'ann', 'web #12', 12, undefined, undefined, undefined, undefined, 'acme/web'), undefined);
  assert.match(String(queue.add('again', 'ann', 'api #12', 12, undefined, undefined, undefined, undefined, 'acme/api')), /api#12 is already on the queue/);
  // Closing web's #12 takes only its task off.
  assert.ok(queue.dropIssue(12, 'acme/web'));
  assert.deepEqual(queue.state().tasks.map((x) => x.repo), ['acme/api']);
  assert.ok(queue.add('fix web', 'ann', 'web #12', 12, undefined, undefined, undefined, undefined, 'acme/web') === undefined);
  // Seated, each one's worker gets a worktree of its issue's repository.
  queue.setLimit(2);
  assert.deepEqual(spawned.map((s) => s.repos?.map((r) => r.name)), [['api'], ['web']]);
  assert.deepEqual(claimed, ['api#12', 'web#12']);
  // A pull request that closes #12 is the task's only in the task's repository.
  const [api, web] = queue.state().tasks as QueueTask[];
  queue.onPulls([pull(4, 'acme/web', 'OPEN', 'fix', { closes: [12], createdAt: new Date().toISOString() })]);
  assert.equal(queue.state().tasks.find((x) => x.id === api.id)?.pr, undefined);
  assert.equal(queue.state().tasks.find((x) => x.id === web.id)?.pr?.number, 4);
});

// ---- The building ------------------------------------------------------------------------------

/** gh for the building: `repo view` and `repo clone` from bare repositories in $FAKE_GH_REPOS. */
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "repo view")
    [ -d "$FAKE_GH_REPOS/$3.git" ] || { echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2; exit 1; }
    echo "{\\"nameWithOwner\\":\\"$3\\",\\"isEmpty\\":false}"
    ;;
  "repo clone")
    git clone -q "$FAKE_GH_REPOS/$3.git" "$4" || exit 1
    git -C "$4" remote set-url origin "https://github.com/$3.git"
    ;;
esac
`;

function building(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-team-'));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const remotes = path.join(root, 'github');
  for (const name of ['acme/api', 'acme/web', 'other/api']) {
    const work = path.join(root, 'work', name);
    mkdirSync(work, { recursive: true });
    git(work, 'init', '-q');
    writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
    git(work, 'add', '.');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    execFileSync('git', ['clone', '-q', '--bare', work, path.join(remotes, `${name}.git`)]);
  }
  // Whatever URL rewriting this machine's own git config does stays out of it.
  const gitConfig = path.join(root, 'gitconfig');
  writeFileSync(gitConfig, '');
  const saved = { PATH: process.env.PATH, FAKE_GH_REPOS: process.env.FAKE_GH_REPOS, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_REPOS = remotes;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, projects: path.join(root, 'projects') };
}

const fast = { clone: { tickMs: 50, stallMs: 3000 } };

test('a team floor is a folder of its own, its repositories cloned into it one folder each', async (t) => {
  const b = building(t);
  const office = new Building(b.dataDir, b.projects, fast);
  const def = office.create('  Payments   team ', 'ann');
  assert.equal(typeof def, 'object', String(def));
  if (typeof def === 'string') return;
  assert.equal(def.name, 'Payments team');
  assert.equal(def.dir, path.join(b.projects, '_floors', 'payments-team'));
  assert.ok(existsSync(def.dir));
  assert.deepEqual([def.team, def.repos, def.repo], [true, [], undefined]);
  assert.match(String(office.create('payments TEAM', 'bob')), /already/);

  let started = 0;
  const api = await office.addRepo(def.id, 'acme/api', 'ann', () => started++);
  assert.equal(typeof api, 'object', String(api));
  assert.equal(started, 1);
  assert.equal(git(path.join(def.dir, 'api'), 'remote', 'get-url', 'origin'), 'https://github.com/acme/api.git');
  assert.match(String(await office.addRepo(def.id, 'https://github.com/acme/api', 'bob', () => {})), /already on Payments team/);
  // Two repositories of one name: the second's folder says whose it is.
  await office.addRepo(def.id, 'acme/web', 'ann', () => {});
  await office.addRepo(def.id, 'other/api', 'ann', () => {});
  assert.deepEqual(office.teamRepos(def.id), [
    { repo: 'acme/api', path: 'api' },
    { repo: 'acme/web', path: 'web' },
    { repo: 'other/api', path: 'other-api' },
  ]);
  assert.match(String(await office.addRepo(def.id, 'acme/nope', 'ann', () => {})), /Couldn't find acme\/nope/);
  assert.equal(await office.addRepo('nowhere', 'acme/web', 'ann', () => {}), 'No such floor');

  // Only admins take one off. Taken off, its checkout stays; added again, it moves back into the same folder without a clone.
  assert.match(String(office.removeRepo(def.id, 'acme/api', 'bob', false, () => true)), /Only admins/);
  const off = office.removeRepo(def.id, 'acme/api', 'admin');
  assert.equal(typeof off, 'object', String(off));
  assert.deepEqual(office.teamRepos(def.id)?.map((r) => r.repo), ['acme/web', 'other/api']);
  assert.ok(existsSync(path.join(def.dir, 'api', 'README.md')));
  writeFileSync(path.join(def.dir, 'api', 'local.txt'), 'kept\n');
  await office.addRepo(def.id, 'acme/api', 'ann', () => {});
  assert.ok(existsSync(path.join(def.dir, 'api', 'local.txt')), 'the same checkout, not a fresh clone');
  assert.match(String(office.removeRepo(def.id, 'acme/nope', 'admin')), /isn't one of/);

  // floors.json keeps it all.
  const again = new Building(b.dataDir, b.projects, fast).list().find((d) => d.id === def.id);
  assert.deepEqual(again && [again.team, again.repos?.map((r) => [r.repo, r.path])], [true, [['acme/web', 'web'], ['other/api', 'other-api'], ['acme/api', 'api']]]);
});

test("a repository on its way into a team floor that's taken off doesn't join it, nor a new floor of the same name", async (t) => {
  const b = building(t);
  const office = new Building(b.dataDir, b.projects, fast);
  const def = office.create('Ops', 'ann');
  if (typeof def === 'string') return assert.fail(def);
  const adding = office.addRepo(def.id, 'acme/api', 'ann', () => {});
  office.remove(def.id, 'admin');
  const again = office.create('Ops', 'ann');
  if (typeof again === 'string') return assert.fail(again);
  assert.equal(again.id, def.id, 'the id is free again');
  assert.match(String(await adding), /taken off the building/);
  assert.deepEqual([def.repos, again.repos], [[], []]);
});

test('floors.json only gives a team floor repositories it can name, in plain folders', () => {
  const kept = validTeamRepos([
    { repo: 'acme/api', path: 'api', addedBy: 'ann', addedAt: 1 },
    { repo: 'acme/api', path: 'api-2' },
    { repo: 'not a repo', path: 'x' },
    { repo: 'acme/web', path: '../escape' },
    { repo: 'acme/ops', path: 'ops' },
  ]);
  assert.deepEqual(kept.map((r) => [r.repo, r.path]), [['acme/api', 'api'], ['acme/ops', 'ops']]);
});

test("the team floor's brief says which folder is which, and leaves the team's own alone", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-brief-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repos = [{ repo: 'acme/api', path: 'api', addedBy: 'a', addedAt: 0 }, { repo: 'acme/web', path: 'web', addedBy: 'a', addedAt: 0 }];
  writeTeamBrief(dir, 'Payments', repos);
  const brief = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), brief);
  for (const line of ['the Payments floor', '`api/`: acme/api', '`web/`: acme/web', 'gh issue list -R owner/name']) assert.ok(brief.includes(line), line);
  assert.ok(!brief.includes('{{'));
  // The team's own AGENTS.md stays; the office's CLAUDE.md goes with the last repository.
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Ours\n');
  writeTeamBrief(dir, 'Payments', []);
  assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Ours\n');
});

// ---- Its workers -------------------------------------------------------------------------------

/** Records where it was started and whether git finds a repository there, then waits. */
const FAKE_AGENT = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let top = null;
try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ cwd: process.cwd(), ceiling: process.env.GIT_CEILING_DIRECTORIES, top }) + '\\n');
setInterval(() => {}, 1000);
`;

/** gh for pull requests, kept in $GH_STATE: list and create, in the repository of the checkout it runs in. */
const FAKE_PR_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.env.GH_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const repo = () => execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^https:\\/\\/github\\.com\\//, '').replace(/\\.git$/, '');
const done = (out, code = 0) => { fs.writeFileSync(file, JSON.stringify(st)); process.stdout.write(out); process.exit(code); };
if (a[0] === 'pr' && a[1] === 'list') done('[]');
if (a[0] === 'pr' && a[1] === 'create') {
  const r = repo();
  const number = st.prs.filter((p) => p.repo === r).length + 1;
  st.prs.push({ repo: r, number, head: opt('--head'), base: opt('--base') });
  done('https://github.com/' + r + '/pull/' + number + '\\n');
}
done('', 1);
`;

const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };

/** A team floor's folder with a checkout of acme/web and acme/api in it, each pushing to a bare repository of its own. */
function teamFloor(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-team-workers-')));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'fake-agent'), FAKE_AGENT, { mode: 0o755 });
  // The task namer asks `claude -p`: not the real one.
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh'), FAKE_PR_GH, { mode: 0o755 });
  const prs = path.join(root, 'prs.json');
  const log = path.join(root, 'starts.jsonl');
  writeFileSync(log, '');
  // Whatever URL rewriting this machine's own git config does stays out of it.
  const gitConfig = path.join(root, 'gitconfig');
  writeFileSync(gitConfig, '');
  const saved = { PATH: process.env.PATH, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GH_STATE: process.env.GH_STATE };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = log;
  process.env.GH_STATE = prs;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const team = path.join(root, 'projects', '_floors', 'payments');
  mkdirSync(team, { recursive: true });
  const checkout = (name: string) => {
    const bare = path.join(root, 'remotes', `${name}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    const dir = path.join(team, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    git(dir, 'config', `url.${bare}.pushInsteadOf`, `https://github.com/acme/${name}.git`);
    git(dir, 'push', '-q', 'origin', 'main');
    excludeFromGit(dir);
    return dir;
  };
  const web = checkout('web');
  const api = checkout('api');
  const sources: RepoSource[] = ['web', 'api'].map((n) => ({ floor: 'payments', name: n, repo: `acme/${n}`, dir: path.join(team, n), checkout: n }));
  const managers: WorkerManager[] = [];
  const open = (repos = sources) => {
    const data = path.join(team, '.agent-office');
    mkdirSync(data, { recursive: true });
    const workers = new WorkerManager(team, data, path.join(bin, 'fake-agent'), [], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    workers.team = () => repos;
    managers.push(workers);
    return workers;
  };
  t.after(() => {
    for (const m of managers) m.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, team, web, api, sources, open, prs: () => (existsSync(prs) ? (JSON.parse(readFileSync(prs, 'utf8')).prs as { repo: string; number: number; head: string; base?: string }[]) : []), starts: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cwd: string; ceiling?: string; top: string | null }) };
}

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let v = read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = read();
  }
  assert.ok(ok(v), 'timed out');
  return v;
}

test("a worker in a team floor's folder starts there, where git finds none of its checkouts", async (t) => {
  const f = teamFloor(t);
  const workers = f.open();
  const w = workers.spawn('desk-1', 'Cody', undefined, false);
  assert.equal(typeof w, 'object', String(w));
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), f.team);
  assert.equal(start.top, null);
  assert.equal(start.ceiling, path.dirname(f.team));
});

test('a worker in its own worktree on a team floor gets a workspace of every one of its repositories', async (t) => {
  const f = teamFloor(t);
  const workers = f.open();
  const w = workers.spawn('desk-1', 'Cody', undefined, true);
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const ws = path.join(f.team, '.agent-office', 'worktrees', slug);
  assert.deepEqual([w.worktree!.path, w.worktree!.checkout, w.worktree!.repo], [path.join('.agent-office', 'worktrees', slug, 'web'), 'web', 'acme/web']);
  assert.deepEqual(w.repos?.map((r) => [r.floor, r.name, r.repo]), [['payments', 'api', 'acme/api']]);
  for (const [name, dir] of [['web', f.web], ['api', f.api]]) {
    assert.equal(git(path.join(ws, name), 'rev-parse', '--abbrev-ref', 'HEAD'), w.worktree!.branch);
    assert.equal(realpathSync(path.resolve(path.join(ws, name), git(path.join(ws, name), 'rev-parse', '--git-common-dir'))), realpathSync(path.join(dir, '.git')));
  }
  const brief = readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8');
  for (const line of ['`web/`: acme/web, cut from main', '`api/`: acme/api, cut from main']) assert.ok(brief.includes(line), line);
  assert.ok(!brief.includes("this floor's project"), 'a team floor has no project of its own');
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.cwd), ws);
  assert.equal(start.top, null);

  // What it holds, then everything taken out again: nothing in it was its work.
  const state = await workers.inspectWorktree(w.id);
  assert.deepEqual(state?.repos?.map((r) => [r.name, r.state.exists]), [['web', true], ['api', true]]);
  const gone = await workers.kill(w.id);
  assert.match(gone.note ?? '', new RegExp(`Deleted ${w.name}'s worktrees and branch office/\\S+ in web, api`));
  assert.ok(!existsSync(ws));
  for (const dir of [f.web, f.api]) assert.equal(git(dir, 'branch', '--list', w.worktree!.branch), '');

  // With none, there's nothing to make one of.
  const empty = f.open([]);
  assert.match(String(empty.spawn('desk-2', 'Cody', undefined, true)), /no repositories/);
});

test("picking one of a team floor's repositories gives a worktree of just it, which comes and goes like a project's own", async (t) => {
  const f = teamFloor(t);
  const workers = f.open();
  const w = workers.spawn('desk-1', 'Cody', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [f.sources[1]]);
  assert.equal(typeof w, 'object', String(w));
  if (typeof w === 'string') return;
  const slug = w.worktree!.branch.replace(/^office\//, '');
  const wt = path.join(f.team, w.worktree!.path);
  assert.deepEqual([w.worktree!.path, w.worktree!.checkout, w.worktree!.repo, w.worktree!.from, w.repos], [path.join('.agent-office', 'worktrees', slug), 'api', 'acme/api', 'main', undefined]);
  assert.equal(realpathSync(path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir'))), realpathSync(path.join(f.api, '.git')));
  const [start] = await waitFor(() => f.starts(), (s) => s.length === 1);
  assert.equal(realpathSync(start.top!), realpathSync(wt));

  // A commit nobody pushed is work: sending it home keeps it.
  writeFileSync(path.join(wt, 'pay.js'), '// pay\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'Pay');
  assert.deepEqual(await workers.inspectWorktree(w.id).then((s) => s && [s.ahead, s.unpushed, s.dirty]), [1, 1, 0]);
  const kept = await workers.kill(w.id);
  assert.match(kept.note ?? '', new RegExp(`Kept ${w.name}'s worktree and branch office/\\S+ — it has 1 unpushed commit`));
  assert.ok(existsSync(wt));

  // Once it's pushed, the next one to go home without work takes its worktree and branch with it.
  const w2 = workers.spawn('desk-2', 'Dee', undefined, true, 'agent', undefined, undefined, undefined, undefined, undefined, [f.sources[1]]) as WorkerInfo;
  const wt2 = path.join(f.team, w2.worktree!.path);
  const gone = await workers.kill(w2.id);
  assert.match(gone.note ?? '', new RegExp(`Deleted ${w2.name}'s worktree and branch`));
  assert.ok(!existsSync(wt2));
  assert.equal(git(f.api, 'branch', '--list', w2.worktree!.branch), '');
});

test("O at the desk of a worker in one of a team floor's repositories opens its pull request there, against the branch it was cut from", async (t) => {
  const f = teamFloor(t);
  const workers = f.open();
  const w = workers.spawn('desk-1', 'Cody', 'Add payments', true, 'agent', undefined, undefined, undefined, undefined, undefined, [f.sources[1]]) as WorkerInfo;
  const wt = path.join(f.team, w.worktree!.path);
  await waitFor(() => workers.get(w.id)?.status, (s) => s !== 'starting');
  writeFileSync(path.join(wt, 'pay.js'), '// pay\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'Pay');
  (workers as any).workers.get(w.id).info.status = 'done';
  const r = await workers.openPr(w.id, 'Cody');
  assert.equal(typeof r, 'object', String(r));
  assert.deepEqual(f.prs(), [{ repo: 'acme/api', number: 1, head: w.worktree!.branch, base: 'main' }]);
  assert.equal(workers.get(w.id)?.pr?.url, 'https://github.com/acme/api/pull/1');
});

test("a worker in a team floor's folder that opens a pull request itself has it, in any of the floor's repositories", (t) => {
  const f = teamFloor(t);
  const workers = f.open();
  const w = workers.spawn('desk-1', 'Cody', undefined, false) as WorkerInfo;
  const handle = (workers as any).workers.get(w.id);
  const prs = (workers as any).prs;
  prs.noteOwn(handle, 'gh pr create --fill', 'https://github.com/acme/web/pull/3\n');
  assert.deepEqual(workers.get(w.id)?.pr, { number: 3, url: 'https://github.com/acme/web/pull/3' });
  // The ones before stay its own, by URL: they may be in another of the floor's repositories.
  prs.noteOwn(handle, 'gh pr create --fill', 'https://github.com/acme/api/pull/5\n');
  prs.noteOwn(handle, 'gh pr create --fill', 'https://github.com/acme/api/pull/6\n');
  assert.deepEqual(workers.get(w.id)?.pastPrs, ['https://github.com/acme/web/pull/3', 'https://github.com/acme/api/pull/5']);
  // So web's #3 still open keeps it from having landed, though api's #6 merged.
  const info = workers.get(w.id)!;
  const pulls = [pull(3, 'acme/web', 'OPEN', 'x'), pull(6, 'acme/api', 'MERGED', 'y'), pull(3, 'acme/api', 'MERGED', 'z')];
  assert.deepEqual(workerPr(info, pulls, []), { state: 'open', number: 3, repo: 'acme/web' });
  // One outside the floor isn't its own.
  prs.noteOwn(handle, 'gh pr create --fill', 'https://github.com/someone/else/pull/9\n');
  assert.equal(workers.get(w.id)?.pr?.number, 6);
});
