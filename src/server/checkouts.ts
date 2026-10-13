// Checkouts on the office's machine: where they go, whether one is there and is what it should be,
// and cloning one or listing what could be cloned. The building's floors and team floors use these.
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepo, sameRepo } from '../shared/floors.js';
import type { RepoChoice } from '../shared/protocol.js';
import { gh } from './github.js';

/** How many repositories the "add a project" list shows at most. */
const MAX_REPOS = 1000;

/** A path under the home folder as ~/…, for showing people. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export function untildify(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `dir` is `parent` or somewhere under it. */
export function within(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the office couldn't make checkouts under `dir`, if it couldn't. It's made on the first clone, so it needn't exist yet. */
export function unwritable(dir: string): string | undefined {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    if (!statSync(at).isDirectory()) return `${tildify(at)} isn't a folder`;
    accessSync(at, constants.W_OK);
  } catch {
    return `The office can't write in ${tildify(at)}`;
  }
  return undefined;
}

/** The GitHub repository a checkout's origin points at. */
export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What's at `dest`: nothing yet ('none'), a checkout of `repo` ('ok'), or why it's in the way. A
 * clone that was cut off has its origin but no commit checked out; an `empty` repository has none to.
 */
export function checkoutAt(dest: string, repo: string, empty: boolean): 'none' | 'ok' | string {
  if (!existsSync(dest)) return 'none';
  if (!statSync(dest).isDirectory()) return `${dest} is already there and isn't a folder`;
  if (!readdirSync(dest).length) return 'none';
  if (!sameRepo(originRepo(dest), repo)) return `${dest} already exists and isn't a checkout of ${repo} — move it out of the way first`;
  if (!empty && !hasCommit(dest)) return `${dest} is a clone of ${repo} that didn't finish — delete that folder and add the floor again`;
  return 'ok';
}

function hasCommit(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: dir, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Clones `repo` to `dest` in this terminal: git shows its progress, and ssh or git can ask here. Resolves to an error, if any. */
export function cloneHere(repo: string, dest: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['repo', 'clone', repo, dest], { cwd: path.dirname(dest), stdio: 'inherit' });
    child.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ENOENT' ? "The GitHub CLI (gh) isn't installed on this machine" : `Couldn't run gh: ${err.message}`));
    child.once('exit', (code, signal) => resolve(code === 0 ? undefined : `Couldn't clone ${repo}: gh ${signal ? `stopped (${signal})` : `failed (exit ${code})`}`));
  });
}

export async function listRepos(cwd: string): Promise<RepoChoice[]> {
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  );
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
