import './team-floor.css';
import type { FloorInfo, FloorRepo, RepoChoice, ServerMsg } from '../../shared/protocol';
import { cloneLabel, normalizeRepo, repoName, sameRepo } from '../../shared/floors';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, type Modal } from './dom';
import { confirmDialog } from './prompt';

// Team floors: a floor that's a folder of its own rather than one repository's checkout, for a team
// that works across several repositories, or in none (see FloorInfo.team). The elevator opens these:
// making one (a name, and the repositories to clone into it), and a team floor's repositories, to add
// more and, for admins, take some off.

/** How many repositories the lists show at once; typing narrows them down. */
const SHOWN = 40;
/** Ask gh for the repositories again after this long. */
const REPOS_STALE_MS = 5 * 60_000;
/** Longer than the office takes to make a floor's folder. */
const CREATE_MS = 30_000;

/** The window waiting on its floor being made, if one is. */
let created: ((msg: Extract<ServerMsg, { t: 'floor.created' }>) => void) | null = null;

/** The elevator feeds server messages through here (see routeElevatorMessage). */
export function routeTeamFloorMessage(msg: ServerMsg) {
  if (msg.t !== 'floor.created') return;
  if (created) created(msg);
  else if (msg.error) toast(`🛗 ${msg.error}`, 'warn');
}

/** A team floor's repositories in a few words, for the elevator: "api · web · docs", or what it has instead. */
export function teamLine(f: FloorInfo): string {
  const repos = f.repos ?? [];
  if (!repos.length) return '🏢 Team floor · no repositories yet';
  return `🏢 ${repos.map((r) => `${repoName(r.repo)}${r.cloning ? ' ⏳' : ''}`).join(' · ')}`;
}

/** Asks the office for the repositories its gh can see, unless it did a moment ago. */
function needRepos(net: Net) {
  const r = store.repos;
  if (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error)) return;
  store.repos = { ...r, loading: true };
  net.send({ t: 'floor.repos' });
}

/**
 * A searchable list of the repositories the office's gh login can see, as the elevator's "add a
 * project" has, where `pick` takes one (typing owner/name offers any other). `tag` says what's beside
 * one already (picked, on the floor), which can't be picked again.
 */
function repoSearch(net: Net, pick: (repo: string) => void, tag: (repo: string) => string | undefined) {
  let filter = '';
  const input = h('input', { type: 'text', placeholder: 'Search your repositories, or type owner/name', 'aria-label': 'Repository', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const refresh = h('button.btn', { type: 'button', title: 'Ask GitHub for the list again' }, '↻');
  const list = h('div.repo-list', { role: 'listbox', 'aria-label': 'Repositories' });
  const row = (r: RepoChoice) => {
    const taken = tag(r.name);
    const el = h(
      'div.repo',
      { role: 'option', class: taken ? 'sel' : '', 'aria-selected': String(!!taken), title: r.description ?? r.name },
      h('span.nm', {}, r.name),
      r.private ? h('span', { title: 'Private' }, '🔒') : null,
      h('span.desc', {}, r.description ?? ''),
      taken ? h('span.pill', {}, taken) : r.pushedAt ? h('span.when', {}, timeAgo(r.pushedAt)) : null,
    );
    el.addEventListener('click', () => !taken && pick(r.name));
    return el;
  };
  const render = () => {
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const typed = normalizeRepo(filter);
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    if (typed && !r.list.some((x) => sameRepo(x.name, typed))) rows.push(row({ name: typed, private: false, description: 'Not in your list — the office will try to clone it' }));
    rows.push(...matches.slice(0, SHOWN).map(row));
    if (!rows.length) rows.push(h('p.empty', { style: 'padding:10px' }, r.loading ? 'Asking GitHub for your repositories…' : r.error ? r.error : q ? 'Nothing matches. Type owner/name to clone any repository.' : 'No repositories.'));
    if (matches.length > SHOWN) rows.push(h('p.empty', { style: 'padding:8px 10px' }, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    list.replaceChildren(...rows);
  };
  input.addEventListener('input', () => {
    filter = input.value;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const q = filter.trim().toLowerCase();
    const matches = store.repos.list.filter((x) => !tag(x.name) && (x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q)));
    const typed = normalizeRepo(filter);
    const choice = typed && !tag(typed) ? typed : q && matches.length === 1 ? matches[0].name : undefined;
    if (!choice) return;
    pick(choice);
    input.value = filter = '';
    render();
  });
  refresh.addEventListener('click', () => {
    store.repos = { ...store.repos, loading: true, error: undefined };
    render();
    net.send({ t: 'floor.repos', refresh: true });
  });
  needRepos(net);
  return { el: h('div', {}, h('div.repo-search', {}, input, refresh), list), render, focus: () => input.focus() };
}

/**
 * 🏢 A new team floor: its name, and the repositories to clone into its folder (none is fine). It
 * opens at once, and `ride` takes you up there; the clones carry on, each joining once it's there.
 */
export function openNewTeamFloor(net: Net, ride: (floor: string) => void) {
  if (created) return;
  const picked: string[] = [];
  let waiting = false;
  let timer: number | undefined;
  const name = h('input', { type: 'text', placeholder: 'Payments team, Docs, Ops…', 'aria-label': 'Floor name', maxlength: '60', autocomplete: 'off' }) as HTMLInputElement;
  const chips = h('div.team-picked');
  const status = h('div');
  const go = h('button.btn.primary', { type: 'button' }, '🏢 Make the floor');
  const search = repoSearch(
    net,
    (repo) => {
      if (!picked.some((p) => sameRepo(p, repo))) picked.push(repo);
      render();
    },
    (repo) => (picked.some((p) => sameRepo(p, repo)) ? 'picked' : undefined),
  );
  const render = () => {
    chips.replaceChildren(
      ...(picked.length
        ? picked.map((repo) =>
            h('span.team-chip', {}, repo, h('button', { type: 'button', 'aria-label': `Leave out ${repo}`, title: 'Leave it out', onclick: () => (picked.splice(picked.indexOf(repo), 1), render()) }, '✕')),
          )
        : [h('span.team-none', {}, 'None yet: a floor with no repository is fine too, and you can add them later.')]),
    );
    search.render();
    go.disabled = waiting || !name.value.trim();
    go.textContent = waiting ? '⏳ Making it…' : picked.length ? `🏢 Make the floor and clone ${picked.length}` : '🏢 Make the floor';
  };
  const el = h(
    'div.modal.elevator.team-floor',
    { role: 'dialog', 'aria-label': 'New team floor' },
    h('header', {}, h('h2', {}, '🏢 New team floor')),
    h(
      'div.body',
      {},
      h('p.intro', {}, "A floor for a team rather than for one repository: a folder of its own with a checkout of each repository you pick, or none for work that isn't in one. Its workers start there with all of them to hand, and its boards show every one's issues and pull requests."),
      h('label.team-name', {}, h('span', {}, 'Name'), name),
      h('h3', {}, '🗂️ Its repositories'),
      chips,
      search.el,
      status,
    ),
    h('footer', {}, h('span.grow', {}, `In ${store.projectsDir.dir}/_floors/, cloned with this machine's gh login`), go),
  );
  const fail = (why: string) => {
    waiting = false;
    clearTimeout(timer);
    status.replaceChildren(h('p.err', {}, why));
    render();
  };
  const submit = () => {
    if (waiting || !name.value.trim()) return name.focus();
    waiting = true;
    status.replaceChildren();
    render();
    net.send({ t: 'floor.create', name: name.value.trim(), repos: [...picked] });
    timer = window.setTimeout(() => fail("The office didn't answer — try again"), CREATE_MS);
  };
  created = (msg) => {
    if (!waiting) return;
    clearTimeout(timer);
    if (msg.error || !msg.floor) return fail(msg.error ?? "The floor couldn't be made");
    modal.close();
    ride(msg.floor);
  };
  go.addEventListener('click', submit);
  name.addEventListener('input', render);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) submit();
  });
  const unsubs = [store.on('repos', render)];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    onClose: () => {
      created = null;
      clearTimeout(timer);
      for (const off of unsubs) off();
    },
  });
  render();
  setTimeout(() => name.focus(), 30);
}

let current: Modal | null = null;

/**
 * 🗂️ A team floor's repositories: each one there or on its way, more to add (anyone can), and for
 * admins, taking one off (its checkout stays in the floor's folder) or stopping its clone.
 */
export function openTeamRepos(net: Net, floorId: string) {
  current?.close();
  const list = h('div.team-repos');
  const title = h('h2');
  const note = h('span.grow');
  const floor = () => store.floors.find((f) => f.id === floorId);
  const search = repoSearch(
    net,
    (repo) => {
      net.send({ t: 'floor.repo.add', floor: floorId, repo });
      toast(`🛗 Cloning ${repo} into ${floor()?.name ?? 'the floor'}…`);
    },
    (repo) => {
      const r = floor()?.repos?.find((x) => sameRepo(x.repo, repo));
      return r ? (r.cloning ? 'cloning' : 'on the floor') : undefined;
    },
  );
  const remove = (f: FloorInfo, r: FloorRepo) => {
    if (r.cloning) return confirmDialog(`Stop cloning ${r.repo}?`, "What's come down so far is thrown away. You can add it again any time.", '⏹️ Stop cloning', () => net.send({ t: 'floor.repo.remove', floor: f.id, repo: r.repo }));
    confirmDialog(
      `Take ${r.repo} off ${f.name}?`,
      `Its issues and pull requests come off the boards, and new workers don't get a worktree of it. Nothing is deleted: its checkout stays in ${f.dir}/${r.path}, and workers already working in it carry on.`,
      '🗑 Take it off',
      () => net.send({ t: 'floor.repo.remove', floor: f.id, repo: r.repo }),
    );
  };
  const render = () => {
    const f = floor();
    if (!f?.team) return modal.close();
    title.textContent = `🗂️ ${f.name}'s repositories`;
    note.textContent = `Each is cloned into ${f.dir}/<folder> with this machine's gh login.`;
    const repos = f.repos ?? [];
    list.replaceChildren(
      ...(repos.length
        ? repos.map((r) =>
            h(
              'div.team-repo',
              {},
              h('span.floor-text', {}, h('span.floor-name', {}, r.repo), h('span.floor-sub', {}, r.cloning ? `${cloneLabel(r.clone)}${r.clone?.detail ? ` · ${r.clone.detail}` : ''}` : `📁 ${r.path}/`)),
              store.me.admin ? h('button.btn.floor-off', { type: 'button', title: r.cloning ? `Stop cloning ${r.repo}` : `Take ${r.repo} off ${f.name}`, 'aria-label': r.cloning ? `Stop cloning ${r.repo}` : `Remove ${r.repo}`, onclick: () => remove(f, r) }, r.cloning ? '⏹️' : '🗑') : null,
            ),
          )
        : [h('p.empty', {}, 'No repositories yet: its workers work in its own folder.')]),
    );
    search.render();
  };
  const el = h(
    'div.modal.elevator.team-floor',
    { role: 'dialog', 'aria-label': 'Team floor repositories' },
    h('header', {}, title),
    h('div.body', {}, list, h('div.add', {}, h('h3', {}, '➕ Add a repository'), search.el)),
    h('footer', {}, note),
  );
  const unsubs = [store.on('floors', render), store.on('repos', render), store.on('me', render)];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    onClose: () => {
      if (current === modal) current = null;
      for (const off of unsubs) off();
    },
  });
  current = modal;
  render();
  setTimeout(() => search.focus(), 30);
}
