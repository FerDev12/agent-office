// The floor's GitHub boards: refreshing them, and merging, commenting on, closing and labeling
// issues and pull requests, as whoever asks (see withGitHub).
import type { GitHubClientMsg } from '../../../shared/protocol.js';
import { GH_COMMENT_MAX, GH_LABEL_MAX } from '../../../shared/protocol.js';
import { ghRef, normalizeRepo } from '../../../shared/floors.js';
import { num, str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const issuesView: ViewPieces['issues'] = (_ctx, floor) => floor?.github.issues ?? { items: [], fetchedAt: 0, loading: false };
export const pullsView: ViewPieces['pulls'] = (_ctx, floor) => floor?.github.pulls ?? { items: [], fetchedAt: 0, loading: false };

export const githubHandlers = {
  'gh.refresh'(ctx, c) {
    void ctx.floorOf(c)?.github.refresh();
  },
  'gh.merge'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const repo = normalizeRepo(msg.repo);
    const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !method) return;
    const board = floor.github.for(repo);
    if (typeof board === 'string') return ctx.sendTo(c, { t: 'gh.merged', number: n, repo, error: board });
    ctx.withGitHub(
      c,
      (as) =>
        void board.merge(n, method, msg.deleteBranch === true, msg.auto === true, as).then((error) => {
          ctx.sendTo(c, { t: 'gh.merged', number: n, repo, error });
          if (error) return;
          ctx.toastFloor(floor, msg.auto ? `${who} set PR ${ghRef(n, repo)} to merge once its checks pass` : `🎉 ${who} merged PR ${ghRef(n, repo)}`);
          // An auto-merge rings once GitHub gets round to it and the boards see it merged.
          if (!msg.auto) floor.merged(n, who, board.repo);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.merged', number: n, repo, error }),
    );
  },
  'gh.comment'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const repo = normalizeRepo(msg.repo);
    const kind = msg.kind === 'pull' ? 'pull' : 'issue';
    if (!floor || !Number.isSafeInteger(n) || n <= 0) return;
    const body = typeof msg.body === 'string' ? msg.body : '';
    // Refused rather than cut short: a comment that silently lost its end would read as finished.
    const board = floor.github.for(repo);
    const invalid = !body.trim() ? 'The comment is empty' : body.length > GH_COMMENT_MAX ? `GitHub takes comments of up to ${GH_COMMENT_MAX} characters` : typeof board === 'string' ? board : '';
    if (invalid || typeof board === 'string') {
      ctx.sendTo(c, { t: 'gh.commented', kind, number: n, repo, error: invalid });
      return;
    }
    ctx.withGitHub(
      c,
      (as) =>
        void board.comment(kind, n, body, as).then((r) => {
          ctx.sendTo(c, { t: 'gh.commented', kind, number: n, repo, ...r });
          if (r.comment) ctx.toastFloor(floor, `💬 ${who} commented on ${kind === 'pull' ? 'PR' : 'issue'} ${ghRef(n, repo)}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.commented', kind, number: n, repo, error }),
    );
  },
  'gh.close'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const repo = normalizeRepo(msg.repo);
    const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) return;
    const reason = msg.reason === 'not planned' ? 'not planned' : 'completed';
    const board = floor.github.for(repo);
    if (typeof board === 'string') return ctx.sendTo(c, { t: 'gh.closed', kind, number: n, repo, error: board });
    ctx.withGitHub(
      c,
      (as) =>
        void board.close(kind, n, { comment: str(msg.comment, 20000).trim() || undefined, reason, deleteBranch: msg.deleteBranch === true }, as).then((error) => {
          ctx.sendTo(c, { t: 'gh.closed', kind, number: n, repo, error });
          if (error) return;
          if (kind === 'pull') return ctx.toastFloor(floor, `${who} closed PR ${ghRef(n, repo)} without merging`);
          // Nobody should be seated for an issue that's closed.
          const dropped = floor.queue.dropIssue(n, board.repo);
          ctx.toastFloor(floor, `${who} closed issue ${ghRef(n, repo)}${reason === 'not planned' ? ' as not planned' : ''}${dropped ? ' and took it off the queue' : ''}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.closed', kind, number: n, repo, error }),
    );
  },
  'gh.labels'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const repo = normalizeRepo(msg.repo);
    const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) return;
    const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((l) => str(l, GH_LABEL_MAX + 1)).filter((l) => l && l.length <= GH_LABEL_MAX))].slice(0, 100);
    const add = names(msg.add);
    const remove = names(msg.remove).filter((l) => !add.includes(l));
    const board = floor.github.for(repo);
    if (!add.length && !remove.length) {
      ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, repo, error: 'No labels to change' });
      return;
    }
    if (typeof board === 'string') return ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, repo, error: board });
    ctx.withGitHub(
      c,
      (as) =>
        void board.setLabels(kind, n, add, remove, as).then((r) => {
          ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, repo, ...r });
          if (r.labels) ctx.toastFloor(floor, `🏷️ ${who} labeled ${kind === 'pull' ? 'PR' : 'issue'} ${ghRef(n, repo)}: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join(' ')}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, repo, error }),
    );
  },
} satisfies HandlerMap<GitHubClientMsg>;
