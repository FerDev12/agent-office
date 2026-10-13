/**
 * 🎨 Floor theme: admins pick how the floor they're on is painted (☰ → Floor theme), from the themes
 * new floors are handed out in, plus the ones only ever picked, like VTwo. The office floor puts up a
 * theme's own dressing (world.ts) once the floor's painted in it (see installMaps), clear of the
 * pictures on its walls.
 */
import { frameRect } from '../../../shared/decor';
import type { Ctx } from '../../core/context';
import { store } from '../../state';
import type { HudAction } from '../../ui/menu';
import { openFloorTheme } from './ui';

export interface FloorThemeDeps {
  /** Adds its item to the ☰ menu (see Hud.addAction). */
  addAction(a: HudAction): () => void;
}

export function installFloorTheme(ctx: Ctx, deps: FloorThemeDeps) {
  deps.addAction({
    id: 'floor-theme',
    icon: '🎨',
    label: 'Floor theme',
    section: 'Office',
    // Everyone's floor: admins repaint it (the office says so too, if anyone else tries).
    shown: () => store.me.admin && !!store.currentFloor(),
    title: () => 'How this floor looks, for everyone on it',
    run: () => openFloorTheme(ctx.net),
  });
  // Pictures hung before the floor was VTwo's keep their place: its dressing makes way for them.
  store.on('decor', () => ctx.office.vtwo.clearOf(store.decor.map(frameRect)));
}
