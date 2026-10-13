import * as THREE from 'three';
import { overlaps, wallPose, type WallRect } from '../../../shared/decor';
import type { FloorPalette } from '../../../shared/floors';
import { FLOOR, WALL_HEIGHT } from '../../../shared/layout';
import { mesh, toon } from '../../world/toon';
import type { Fixture } from '../../world/office/fixture';

// The VTwo floor's own dressing, up while the floor's painted in its theme (see FLOOR_PALETTES): the V,
// lit from behind, high on the south wall over the balcony door and the bookshelf; a purple-lit niche
// floor to ceiling between the balcony door and the window east of it, with a poster in it; and a line
// of purple light along the south wall over the windows. (The theme's furniture colors are its own,
// see FloorPalette.furniture.) Pictures already hanging where it goes win: the V or the niche stays
// down while one's in the way, and the line of light stops either side of it.

declare module '../../world/types' {
  interface OfficeHandles {
    /** The VTwo floor's dressing, told which pictures hang on the walls (see installFloorTheme). */
    vtwo: { clearOf(pictures: readonly WallRect[]): void };
  }
}

/** The V: its middle on the south wall, and its size. */
const V = { u: -4.4, y: 4.75, w: 2.6, h: 2.3 } as const;
/** How far the light behind the V reaches past it. */
const GLOW = 0.45;
/** The purple niche, floor to ceiling. */
const NICHE = { u: -1.5, w: 1.3, h: WALL_HEIGHT } as const;
/** The line of light: from the kitchen's corner to the foot of the stairs, just over the windows. */
const STRIP = { u0: FLOOR.minX + 0.4, u1: 2.8, y: 3.5, h: 0.045 } as const;
const PURPLE = '#8b5cf6';
const INK = '#1c1b20';

/** The stretches of the south wall the V (with its light) and the niche take. */
const SIGN_RECT: WallRect = { wall: 'south', u0: V.u - V.w / 2 - GLOW, u1: V.u + V.w / 2 + GLOW, y0: V.y - V.h / 2 - GLOW, y1: Math.min(WALL_HEIGHT, V.y + V.h / 2 + GLOW) };
const NICHE_RECT: WallRect = { wall: 'south', u0: NICHE.u - NICHE.w / 2, u1: NICHE.u + NICHE.w / 2, y0: 0, y1: NICHE.h };

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

/** Unit-box points as points on a `w` by `h` V, centered. */
const scaled = (pts: Pt[], w: number, h: number) => pts.map(([x, y]) => new THREE.Vector2((x - 0.5) * w, (y - 0.5) * h));

/** The V in 3D, a few centimeters proud of the wall, `w` by `h`. */
function letter(w: number, h: number): THREE.Mesh {
  const right = new THREE.Shape(scaled(RIGHT, w, h));
  right.holes.push(new THREE.Path(scaled(inset(RIGHT, RIGHT_BAND), w, h)));
  const geo = new THREE.ExtrudeGeometry([new THREE.Shape(scaled(LEFT, w, h)), new THREE.Shape(scaled(INNER, w, h)), right], { depth: 0.06, bevelEnabled: false });
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
  // A few passes, each blurred wider, so it's bright at the letter and fades out across the concrete
  // before the sheet's edge.
  for (const blur of [26, 13, 6]) {
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

type Run = readonly [number, number];

/** [u0, u1] with each of `cuts` taken out of it: the stretches left, longer than a hand's width. */
export function uncut(u0: number, u1: number, cuts: readonly Run[]): Run[] {
  let runs: Run[] = [[u0, u1]];
  for (const [a, b] of cuts) {
    runs = runs.flatMap(([s, e]): Run[] => {
      if (b <= s || a >= e) return [[s, e]];
      const left: Run[] = a > s ? [[s, a]] : [];
      const right: Run[] = b < e ? [[b, e]] : [];
      return [...left, ...right];
    });
  }
  return runs.filter(([s, e]) => e - s > 0.1);
}

export const vtwo: Fixture<'vtwo'> = (site) => {
  const group = new THREE.Group();
  group.visible = false;

  const sign = new THREE.Group();
  const glow = halo(V.w, V.h, GLOW);
  glow.position.z = 0.012;
  const v = letter(V.w, V.h);
  v.position.z = 0.09;
  sign.add(glow, v);
  onSouthWall(sign, V.u, V.y, 0);
  group.add(sign);

  const n = niche();
  onSouthWall(n, NICHE.u, 0, 0);
  group.add(n);

  const strip = new THREE.Group();
  const stripMat = new THREE.MeshBasicMaterial({ color: PURPLE, toneMapped: false });
  group.add(strip);
  site.group.add(group);

  // No pictures over the V (and its light) or the niche while they're up.
  const holdSign = site.wall('south', (SIGN_RECT.u0 + SIGN_RECT.u1) / 2, (SIGN_RECT.y0 + SIGN_RECT.y1) / 2, SIGN_RECT.u1 - SIGN_RECT.u0, SIGN_RECT.y1 - SIGN_RECT.y0);
  const holdNiche = site.wall('south', NICHE.u, NICHE.h / 2, NICHE.w, NICHE.h);

  let on = false;
  let pictures: readonly WallRect[] = [];
  /** Puts up what the theme and the pictures in the way leave room for. */
  function refresh() {
    group.visible = on;
    sign.visible = on && !pictures.some((r) => overlaps(r, SIGN_RECT));
    n.visible = on && !pictures.some((r) => overlaps(r, NICHE_RECT));
    holdSign(sign.visible);
    holdNiche(n.visible);
    // The line of light stops at the niche and either side of every picture that hangs across it.
    for (const m of strip.children as THREE.Mesh[]) m.geometry.dispose();
    strip.clear();
    if (!on) return;
    const cuts: Run[] = pictures.filter((r) => r.wall === 'south' && r.y0 < STRIP.y + STRIP.h && r.y1 > STRIP.y - STRIP.h).map((r) => [r.u0 - 0.05, r.u1 + 0.05]);
    if (n.visible) cuts.push([NICHE_RECT.u0, NICHE_RECT.u1]);
    for (const [s, e] of uncut(STRIP.u0, STRIP.u1, cuts)) {
      const run = mesh(new THREE.BoxGeometry(e - s, STRIP.h, 0.04), stripMat, 0, 0, 0, false);
      onSouthWall(run, (s + e) / 2, STRIP.y, 0.03);
      strip.add(run);
    }
  }
  refresh();

  return {
    handle: {
      vtwo: {
        clearOf(rects) {
          pictures = rects;
          refresh();
        },
      },
    },
    setLook(p: FloorPalette) {
      on = p.brand === 'vtwo';
      refresh();
    },
  };
};
