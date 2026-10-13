import './ui.css';
import { FLOOR_PALETTES, type FloorPalette } from '../../../shared/floors';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';

/** A little picture of a theme: its wall over its floor, with the trim between (and a brand's mark). */
function swatch(p: FloorPalette): HTMLElement {
  return h(
    'span.theme-swatch',
    { class: p.surface === 'concrete' ? 'concrete' : '', style: `--wall:${p.wall};--trim:${p.trim};--floor:${p.floor};--alt:${p.floorAlt};--seam:${p.seam}`, 'aria-hidden': 'true' },
    p.brand === 'vtwo' ? h('span.theme-mark', {}, 'V') : null,
  );
}

/** 🎨 Floor theme, for admins: how the floor you're on is painted, for everyone on it. */
export function openFloorTheme(net: Net) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const body = h('div.body.floor-theme');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Floor theme', style: 'width:min(620px,100%)' }, h('header', {}, h('h2', {}, '🎨 Floor theme'), close), body);

  const render = () => {
    const floor = store.currentFloor();
    body.replaceChildren();
    if (!floor) return body.append(h('p.empty', {}, 'Ride the elevator to a floor first.'));
    body.append(
      h('p.note', {}, `How the ${floor.name} floor looks: its walls, their trim and its floor. Everyone on it sees the change straight away.`),
      h(
        'div.theme-grid',
        { role: 'radiogroup', 'aria-label': 'Themes' },
        ...FLOOR_PALETTES.map((p, i) =>
          h(
            'button.theme-card',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(floor.palette === i),
              class: floor.palette === i ? 'on' : '',
              title: p.pickOnly ? `${p.name}: only ever by pick` : p.name,
              onclick: () => floor.palette !== i && net.send({ t: 'floor.theme', floor: floor.id, palette: i }),
            },
            swatch(p),
            h('span.theme-name', {}, p.name),
          ),
        ),
      ),
      h('p.note', {}, 'New floors still get a theme of their own nobody else has. VTwo is only ever picked here.'),
    );
  };

  // No longer an admin (someone changed your role): it isn't yours to change any more.
  const unsubs = [store.on('floors', render), store.on('floor', render), store.on('me', () => (store.me.admin ? render() : modal.close()))];
  const modal = openModal(el, { onClose: () => unsubs.forEach((u) => u()) });
  close.addEventListener('click', () => modal.close());
  render();
}
