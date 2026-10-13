/**
 * Carrying an issue card: off the issues board (or its window's ✋) into your hands, and E with it at
 * an empty desk, a worker, the queue, the meeting room or the herald hands it over; Q puts it back.
 * Which card you hold is the office's (ctx.carrying), since so much else looks at it.
 */
import type { AgentEffort, AgentProvider, CarriedIssue, GhIssue, WorkerInfo } from '../../../shared/protocol';
import { isAsleep } from '../../../shared/status';
import type { Ctx, Hint } from '../../core/context';
import { aside, key } from '../../core/hint';
import { store } from '../../state';
import { issuePrompt } from '../../ui/github/prompts';
import { ghRef, sameGh, sameRepo, teamRepoKey } from '../../../shared/floors';
import { canWorktree } from '../../shared/hiring';
import { closeAllModals, h, toast } from '../../ui/dom';
import { issueMeeting, type MeetingPreset } from '../../ui/meeting';
import { worktreePref } from '../../ui/prompt';
import { officeChoice } from '../../ui/provider';
import { hiringPaused } from '../../ui/usage';
import type { Interactable } from '../../world/types';

export interface CarryingDeps {
  /** Puts `card` in your hands, or none: what ctx.carrying says from then on. */
  hold(card: CarriedIssue | null): void;
  /** The issues board, which leaves off the cards someone's carrying around (see features/boards). */
  boards: { cardMoved(): void };
  /** The note on the issues board you're pointing at, if any (see aimedNote in input/pointer.ts). */
  aimedNote(): GhIssue | null;
  /** Plays the reach on your hands and your character, and shows it to everyone else. */
  reach(): void;
  /** Drops the ball, if it's in your hands (see features/basketball). */
  dropBall(): void;
  /** Hires a worker at `deskId` (see hire in features/workers/actions.ts). */
  hire(deskId: string, prompt?: string, worktree?: boolean, provider?: AgentProvider, model?: string, effort?: AgentEffort, issue?: number, repos?: string[], via?: 'herald', issueRepo?: string): void;
  /** The seat the herald sends a new worker to (see heraldSeat in features/workers/views.ts). */
  heraldSeat(): string | undefined;
  /** Seats you've just sent a worker out to from the herald, so a second goes elsewhere. */
  heraldHires: Map<string, { floor: string | null; at: number }>;
  /** The office is at its worker limit: says so, and says yes. */
  officeIsFull(): boolean;
  /** The meeting room's window, prefilled with `preset`. */
  showMeeting(preset?: MeetingPreset): void;
}

export function installCarrying(ctx: Ctx, deps: CarryingDeps) {
  function setCarrying(card: CarriedIssue | null) {
    const held = ctx.carrying();
    if ((card?.issue ?? 0) === (held?.issue ?? 0) && card?.repo === held?.repo) return;
    deps.hold(card);
    ctx.me.carry(card);
    ctx.hands.carry(card);
    ctx.net.send({ t: 'carry', issue: card?.issue, title: card?.title, repo: card?.repo });
    deps.boards.cardMoved();
    ctx.hint.invalidate();
  }

  /** ✋ in an issue's window, or E at its note on the board: its card comes off the board and into your hands. */
  function pickUp(it: GhIssue) {
    closeAllModals();
    deps.dropBall();
    const carrying = ctx.carrying();
    if (carrying && sameGh(it, carrying.issue, carrying.repo)) return;
    if (carrying) toast(`📌 ${ghRef(carrying.issue, carrying.repo)} went back on the board`);
    setCarrying({ issue: it.number, title: it.title, ...(it.repo ? { repo: it.repo } : {}) });
    ctx.sound.paper();
    toast(`✋ You took ${ghRef(it.number, it.repo)} off the board: take it to an empty desk, a worker or the 📋 queue and press E`);
  }

  /** Q, or E at the issues board: the card goes back where it came from. */
  function putBack() {
    const carrying = ctx.carrying();
    if (!carrying) return;
    toast(`📌 ${ghRef(carrying.issue, carrying.repo)} is back on the board`);
    setCarrying(null);
    ctx.sound.paper();
  }
  ctx.keys.bind({
    code: 'KeyQ',
    when: () => !!ctx.carrying(),
    run: () => {
      deps.reach();
      putBack();
    },
  });

  /**
   * E with a card in your hands: an empty desk hires a worker for the issue (with the prompt 🤖 Hand
   * to a worker uses), an agent at a desk gets it as its next prompt, the queue board queues it, and
   * the issues board takes it back (or swaps it for the `note` you point at there). False when it's none
   * of those, so E does what it always does there.
   */
  function dropCard(it: Interactable, card: CarriedIssue, note: GhIssue | null): boolean {
    if (it.kind === 'issues') {
      if (note) pickUp(note);
      else putBack();
      return true;
    }
    const prompt = issuePrompt({ number: card.issue, title: card.title, repo: card.repo });
    const ref = ghRef(card.issue, card.repo);
    if (it.kind === 'queue') {
      if (onQueue(card)) toast(`${ref} is already on the queue`, 'warn');
      else {
        const { provider, model, effort } = officeChoice(store.project);
        ctx.net.send({ t: 'queue.add', prompt, title: `${ref} ${card.title}`, issue: card.issue, repo: card.repo, provider, model, effort });
        putDown();
      }
      return true;
    }
    // At the meeting room: a meeting about it, and the card goes back up on the board.
    if (it.kind === 'meeting' || (it.kind === 'desk' && it.deskId && ctx.plan().byId.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
      putBack();
      deps.showMeeting(issueMeeting(card.issue, card.title, card.repo));
      return true;
    }
    // To the herald: someone's sent out for it, to the first free seat.
    if (it.kind === 'herald') {
      const deskId = deps.heraldSeat();
      if (!deskId) toast('Every seat at the tables is taken', 'warn');
      else if (hiringPaused()) toast('💸 Budget spent — hiring resumes tomorrow', 'warn');
      else if (!deps.officeIsFull()) {
        const { provider, model, effort } = officeChoice(store.project);
        deps.heraldHires.set(deskId, { floor: store.floor, at: performance.now() });
        const worktree = canWorktree() && worktreePref();
        deps.hire(deskId, prompt, worktree, provider, model, effort, card.issue, worktree ? ownRepo(card.repo) : undefined, 'herald', card.repo);
        putDown();
      }
      return true;
    }
    if (it.kind !== 'desk' || !it.deskId) return false;
    const w = store.workerAtDesk(it.deskId);
    const why = w ? cantTakeCard(w) : hiringPaused() ? '💸 Budget spent — hiring resumes tomorrow' : '';
    if (why) toast(why, 'warn');
    else if (w) {
      ctx.net.send({ t: 'worker.prompt', workerId: w.id, prompt, issue: card.issue, issueRepo: card.repo });
      putDown();
    } else if (!deps.officeIsFull()) {
      const { provider, model, effort } = officeChoice(store.project);
      const worktree = canWorktree() && worktreePref();
      deps.hire(it.deskId, prompt, worktree, provider, model, effort, card.issue, worktree ? ownRepo(card.repo) : undefined, undefined, card.repo);
      putDown();
    }
    return true;
  }

  /** The card left your hands for a desk or the queue (the office says who took it). */
  function putDown() {
    setCarrying(null);
    ctx.sound.paper();
  }

  function onQueue(card: CarriedIssue): boolean {
    const t = store.taskForIssue(card.issue, card.repo);
    return !!t && t.status !== 'done';
  }

  /** On a team floor, the worktree of a worker hired for a card is of the card's issue's repository. */
  function ownRepo(repo: string | undefined): string[] | undefined {
    const here = store.currentFloor();
    const r = repo && here?.team ? here.repos?.find((x) => !x.cloning && sameRepo(x.repo, repo)) : undefined;
    return r && here ? [teamRepoKey(here.id, r.path)] : undefined;
  }

  /** Why the worker at a desk can't be handed an issue card right now, or '' when it can. */
  function cantTakeCard(w: WorkerInfo): string {
    if (w.kind === 'shell') return `${w.name} is a shell, not an agent`;
    if (w.lost) return `${w.name}'s worktree was deleted — press E at its desk to fix it`;
    if (isAsleep(w.status)) return `${w.name} is asleep — press R to resume first`;
    if (w.status === 'needs_input') return `${w.name} is waiting on an answer — open the terminal first`;
    return '';
  }

  /** With an issue card in your hands: what E does with it here, and how to put it back. */
  function carryHint(card: CarriedIssue, it: Interactable | null): Hint {
    const parts = (...mid: (HTMLElement | string)[]) => [h('span.title', {}, `🗂️ ${ghRef(card.issue, card.repo)} in hand`), ...mid, key('Q', 'Put it back')];
    const aimedNote = deps.aimedNote();
    if (it?.kind === 'issues') return aimedNote ? { k: ghRef(aimedNote.number, aimedNote.repo), parts: parts(key('E', `Swap it for ${ghRef(aimedNote.number, aimedNote.repo)}`)) } : { k: '', parts: parts(key('E', 'Pin it back up')) };
    if (it?.kind === 'ball') return { k: 'ball', parts: parts(aside('🏀 hands full')) };
    if (it?.kind === 'queue') {
      const on = onQueue(card);
      return { k: String(on), parts: parts(on ? aside('already on the queue') : key('E', 'Put it on the queue')) };
    }
    if (it?.kind === 'herald') {
      const paused = hiringPaused();
      return { k: `herald|${paused}`, parts: parts(paused ? h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow') : key('E', 'Send someone out for it')) };
    }
    if (it?.kind === 'meeting' || (it?.kind === 'desk' && it.deskId && ctx.plan().byId.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
      return { k: 'meeting', parts: parts(key('E', 'Call a meeting about it')) };
    }
    if (it?.kind === 'desk' && it.deskId) {
      const w = store.workerAtDesk(it.deskId);
      if (!w) {
        const paused = hiringPaused();
        return { k: String(paused), parts: parts(paused ? h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow') : key('E', 'Hire a worker for it')) };
      }
      const why = cantTakeCard(w);
      return { k: w.id + w.status + why, parts: parts(why ? aside(why) : key('E', `Hand it to ${w.name}`)) };
    }
    // Anything else works as usual, card in hand.
    if (it) {
      const rest = ctx.interactions.hint(it);
      return { k: rest.k, parts: parts(...rest.parts) };
    }
    return { k: '', parts: parts(aside('take it to an empty desk, a worker or the 📋 queue')) };
  }

  return { setCarrying, pickUp, dropCard, carryHint };
}
