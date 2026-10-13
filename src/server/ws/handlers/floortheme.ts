// A floor's theme: how it's painted. Admins pick it; everyone sees it in the next list of floors.
import { floorPalette } from '../../../shared/floors.js';
import type { FloorThemeClientMsg } from '../../../shared/protocol.js';
import { str } from '../../office/input.js';
import type { HandlerMap } from './types.js';

export const floorThemeHandlers = {
  'floor.theme'(ctx, c, msg) {
    // It's everyone's floor: admins repaint it.
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can change a floor’s theme');
    const r = ctx.building.setPalette(str(msg.floor, 64), msg.palette);
    if (typeof r === 'string') return ctx.warn(c, r);
    const who = c.peer.name;
    console.log(`  ${who} painted the ${r.name} floor in ${floorPalette(r.palette).name}`);
    ctx.floorsChanged();
    ctx.toastAll(`🎨 ${who} gave the ${r.name} floor the ${floorPalette(r.palette).name} theme`);
  },
} satisfies HandlerMap<FloorThemeClientMsg>;
