import type { ServerMsg } from '../../../shared/protocol';
import { store } from '../../state';

// Talking to the office about GitHub: the reads (over HTTP, for the floor you're on), and the
// answers to what the dialogs asked for over the socket (merged, commented, closed, labeled).

/** The board windows ask about the floor you're on. */
function onFloor(url: string): string {
  return store.floor ? `${url}${url.includes('?') ? '&' : '?'}floor=${encodeURIComponent(store.floor)}` : url;
}

/** A board read about one issue or pull request, in its repository on a team floor (GhIssue.repo). */
export function inRepo(url: string, repo: string | undefined): string {
  return repo ? `${url}${url.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repo)}` : url;
}

/** What a dialog waiting on the office's answer about an issue or pull request is filed under. */
export function waitKey(kind: 'issue' | 'pull', n: number, repo?: string): string {
  return `${kind}:${repo?.toLowerCase() ?? ''}#${n}`;
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(onFloor(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function getText(url: string): Promise<string> {
  const r = await fetch(onFloor(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.text();
}

// Each by waitKey.
export const mergeWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.merged' }>) => void>();
export const commentWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.commented' }>) => void>();
export const closeWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.closed' }>) => void>();
export const labelWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'gh.labeled' }>) => void>();

/** Main feeds server messages through here so an open merge, close or label dialog or comment box hears back. */
export function routePullMessage(msg: ServerMsg) {
  if (msg.t === 'gh.merged') mergeWaiters.get(waitKey('pull', msg.number, msg.repo))?.(msg);
  if (msg.t === 'gh.commented') commentWaiters.get(waitKey(msg.kind, msg.number, msg.repo))?.(msg);
  if (msg.t === 'gh.closed') closeWaiters.get(waitKey(msg.kind, msg.number, msg.repo))?.(msg);
  if (msg.t === 'gh.labeled') labelWaiters.get(waitKey(msg.kind, msg.number, msg.repo))?.(msg);
}
