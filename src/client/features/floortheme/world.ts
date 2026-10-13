import * as THREE from 'three';
import { wallPose } from '../../../shared/decor';
import type { FloorPalette } from '../../../shared/floors';
import { FLOOR } from '../../../shared/layout';
import { mesh, toon } from '../../world/toon';
import type { Fixture } from '../../world/office/fixture';
import { PALETTE } from '../../world/office/materials';

// The VTwo floor's own dressing, up while the floor's painted in its theme (see FLOOR_PALETTES): the V,
// lit from behind, high on the south wall over the balcony door and the bookshelf; a purple-lit niche
// floor to ceiling between the balcony door and the window east of it, with a poster in it; and a line
// of purple light along the south wall over the windows. The desks go walnut, their chairs and mugs
// black, and the rugs charcoal.

/** The V: its middle on the south wall, and its size. */
const V = { u: -4.4, y: 4.75, w: 2.6, h: 2.3 } as const;
/** The purple niche, floor to ceiling. */
const NICHE = { u: -1.5, w: 1.3, h: 6.8 } as const;
/** The line of light: from the kitchen's corner to the foot of the stairs, just over the windows. */
const STRIP = { u0: FLOOR.minX + 0.4, u1: 2.8, y: 3.5 } as const;
const PURPLE = '#8b5cf6';
const INK = '#1c1b20';

type Pt = readonly [number, number];
/** VTwo's V in a unit box (y up): a broad stroke and a thin one down the left, and the right arm drawn as an outline. */
const LEFT: Pt[] = [
  [0.0, 1.0],
  [0.15, 1.0],
  [0.565, 0.12],
  [0.5, 0.0],
];
const INNER: Pt[] = [
  [0.23, 1.0],
  [0.29, 1.0],
  [0.585, 0.4],
  [0.53, 0.4],
];
const RIGHT: Pt[] = [
  [0.5, 0.0],
  [1.0, 1.0],
  [0.6, 1.0],
];
/** How thick the right arm's outline is, as a share of the way to its middle. */
const RIGHT_BAND = 0.32;

/** The right arm's hole: its outline drawn in toward the middle. */
function inset(pts: Pt[], by: number): Pt[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [x + (cx - x) * by, y + (cy - y) * by]);
}

function shape(pts: Pt[], w: number, h: number): THREE.Shape {
  return new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2((x - 0.5) * w, (y - 0.5) * h)));
}

/** The V in 3D, a few centimeters proud of the wall, `w` by `h`. */
function letter(w: number, h: number): THREE.Mesh {
  const right = shape(RIGHT, w, h);
  right.holes.push(new THREE.Path(inset(RIGHT, RIGHT_BAND).map(([x, y]) => new THREE.Vector2((x - 0.5) * w, (y - 0.5) * h))));
  const geo = new THREE.ExtrudeGeometry([shape(LEFT, w, h), shape(INNER, w, h), right], { depth: 0.06, bevelEnabled: false });
  return mesh(geo, toon(INK), 0, 0, 0, false);
}

/** The light behind the V: a soft white halo round its outline, on a sheet `pad` wider each way. */
function halo(w: number, h: number, pad: number): THREE.Mesh {
  const c = document.createElement('canvas');
  const px = 256 / (w + 2 * pad);
  c.width = 256;
  c.height = Math.round((h + 2 * pad) * px);
  const g = c.getContext('2d')!;
  const trace = (pts: Pt[]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo']((pad + x * w) * px, (pad + (1 - y) * h) * px));
    g.closePath();
  };
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  g.shadowColor = '#fff6e8';
  // A few passes, each blurred wider, so it's bright at the letter and fades out across the concrete.
  for (const blur of [40, 20, 8]) {
    g.shadowBlur = blur;
    for (const pts of [LEFT, INNER, RIGHT]) {
      trace(pts);
      g.fill();
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  return mesh(new THREE.PlaneGeometry(w + 2 * pad, h + 2 * pad), mat, 0, 0, 0, false);
}

/** Puts `o` on the south wall at `u` along it and `y` up, `out` meters into the room. */
function onSouthWall(o: THREE.Object3D, u: number, y: number, out: number) {
  const p = wallPose('south', u, y, out);
  o.position.set(p.x, p.y, p.z);
  o.rotation.y = p.rotY;
}

/** The niche: deep purple, lit at its edges, with a poster of the V in it. */
function niche(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(NICHE.w, NICHE.h, 0.04), toon('#3b1a6b', { emissive: '#1d0b3a' }), 0, NICHE.h / 2, 0.02, false));
  const light = new THREE.MeshBasicMaterial({ color: PURPLE, toneMapped: false });
  for (const side of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.05, NICHE.h, 0.05), light, (side * (NICHE.w - 0.05)) / 2, NICHE.h / 2, 0.05, false));
  const poster = new THREE.Group();
  poster.add(mesh(new THREE.BoxGeometry(0.86, 1.5, 0.03), toon(INK), 0, 0, 0, false));
  const mark = letter(0.34, 0.3);
  mark.material = toon('#e9e6f2');
  mark.scale.z = 0.2;
  mark.position.set(0, -0.42, 0.016);
  poster.add(mark);
  poster.position.set(0, 2.1, 0.07);
  g.add(poster);
  return g;
}

/**
 * What the furniture's painted in on a VTwo floor, by the office's own material for it. The office's
 * materials are shared by color (toon), so this finds the desks, chairs, mugs and rugs by theirs.
 */
function furniture(): Map<THREE.Material, THREE.Material> {
  const dark = toon('#26252b');
  return new Map<THREE.Material, THREE.Material>([
    [toon(PALETTE.desk), toon('#6b4a35')],
    ...PALETTE.chairs.map((c) => [toon(c), dark] as const),
    ...PALETTE.rugs.map((c) => [toon(c), toon('#56555c')] as const),
  ]);
}

export const vtwo: Fixture = (site) => {
  const group = new THREE.Group();
  group.visible = false;

  // The furniture to repaint, found now: once the workers sit down, their clothes share those colors too.
  const swap = furniture();
  const restyled: { mesh: THREE.Mesh; own: THREE.Material; vtwo: THREE.Material }[] = [];
  const collect = (o: THREE.Object3D) => {
    if (!(o instanceof THREE.Mesh)) return;
    const to = swap.get(o.material as THREE.Material);
    if (to) restyled.push({ mesh: o, own: o.material as THREE.Material, vtwo: to });
  };
  for (const d of site.desks.values()) d.group.traverse(collect);
  // The rugs lie on the floor itself.
  for (const o of site.group.children) collect(o);

  const sign = new THREE.Group();
  const glow = halo(V.w, V.h, 0.7);
  glow.position.z = 0.012;
  const v = letter(V.w, V.h);
  v.position.z = 0.09;
  sign.add(glow, v);
  onSouthWall(sign, V.u, V.y, 0);
  group.add(sign);

  const n = niche();
  onSouthWall(n, NICHE.u, 0, 0);
  group.add(n);

  const strip = mesh(new THREE.BoxGeometry(STRIP.u1 - STRIP.u0, 0.045, 0.04), new THREE.MeshBasicMaterial({ color: PURPLE, toneMapped: false }), 0, 0, 0, false);
  onSouthWall(strip, (STRIP.u0 + STRIP.u1) / 2, STRIP.y, 0.03);
  group.add(strip);

  site.group.add(group);
  // No pictures over the V or the niche while they're up.
  const up = () => group.visible;
  site.wall('south', V.u, V.y, V.w + 0.6, V.h + 0.4, up);
  site.wall('south', NICHE.u, NICHE.h / 2, NICHE.w + 0.1, NICHE.h, up);

  return {
    setLook(p: FloorPalette) {
      group.visible = p.brand === 'vtwo';
      for (const r of restyled) r.mesh.material = group.visible ? r.vtwo : r.own;
    },
  };
};
