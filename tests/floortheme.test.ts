// A floor's theme: admins repaint a floor (☰ → Floor theme), it's kept in floors.json, and the themes
// only ever picked (VTwo) are never handed to a new floor by themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef } from '../src/server/building.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Client } from '../src/server/office/client.js';
import { floorThemeHandlers } from '../src/server/ws/handlers/floortheme.js';
import { AUTO_PALETTES, FLOOR_PALETTES, isPalette } from '../src/shared/floors.js';
import { uncut } from '../src/client/features/floortheme/world.js';

const VTWO = FLOOR_PALETTES.findIndex((p) => p.brand === 'vtwo');

/** A building whose floors are painted in `palettes`, one floor each. */
function office(t: { after(fn: () => void): void }, palettes: number[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-theme-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const defs: FloorDef[] = palettes.map((palette, i) => {
    const dir = path.join(root, 'acme', `p${i}`);
    mkdirSync(dir, { recursive: true });
    return { id: `p${i}`, name: `p${i}`, repo: `acme/p${i}`, dir, palette, addedBy: 'Sam', addedAt: 1 };
  });
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs));
  return { root, dataDir };
}

const savedPalette = (dataDir: string, id: string) => (JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[]).find((d) => d.id === id)?.palette;

test('VTwo is a theme to pick, never one a new floor is handed', () => {
  assert.ok(VTWO >= 0, 'there is a VTwo theme');
  assert.equal(FLOOR_PALETTES[VTWO].pickOnly, true);
  assert.equal(FLOOR_PALETTES[VTWO].surface, 'concrete');
  assert.ok(!AUTO_PALETTES.includes(VTWO));
  assert.equal(AUTO_PALETTES.length, FLOOR_PALETTES.length - 1);
  assert.ok(isPalette(0) && isPalette(VTWO));
  for (const bad of [-1, FLOOR_PALETTES.length, 1.5, '1', null]) assert.ok(!isPalette(bad), String(bad));
});

test('a new floor takes a theme nobody has, and goes round the handed-out ones again once they are all taken', (t) => {
  const { root, dataDir } = office(t, [...AUTO_PALETTES]);
  const building = new Building(dataDir, root);
  const dir = path.join(root, 'acme', 'next');
  mkdirSync(dir, { recursive: true });
  const def = building.ensureLocal(dir, 'Sam')!;
  assert.notEqual(def.palette, VTWO);
  assert.ok(AUTO_PALETTES.includes(def.palette));
});

test('a floor is repainted and stays that way after a restart; unknown floors and themes are refused', (t) => {
  const { root, dataDir } = office(t, [0, 1]);
  const building = new Building(dataDir, root);

  const r = building.setPalette('p1', VTWO);
  assert.equal((r as FloorDef).palette, VTWO);
  assert.equal(savedPalette(dataDir, 'p1'), VTWO);
  assert.equal(new Building(dataDir, root).list().find((d) => d.id === 'p1')?.palette, VTWO);

  assert.equal(building.setPalette('nope', 0), 'No such floor');
  assert.equal(building.setPalette('p0', FLOOR_PALETTES.length), 'No such theme');
  assert.equal(building.setPalette('p0', -1), 'No such theme');
  assert.equal(savedPalette(dataDir, 'p0'), 0);
});

test('a theme floors.json names that there is none of is read as the first, not wrapped round onto another', (t) => {
  const { root, dataDir } = office(t, [VTWO, FLOOR_PALETTES.length, FLOOR_PALETTES.length + VTWO, -2]);
  const palettes = new Building(dataDir, root).list().map((d) => d.palette);
  assert.deepEqual(palettes, [VTWO, 0, 0, 0]);
});

/** Just enough of the office's context for the handler: who's an admin, the building, and what it says. */
function fakeCtx(building: Building, admin: boolean) {
  const said = { warned: [] as (string | undefined)[], toasts: [] as { floor: unknown; text: string }[], floorsChanged: 0 };
  const floor = { id: 'p0' };
  const ctx = {
    building,
    floors: new Map([['p0', floor]]),
    meOf: () => ({ admin }),
    warn: (_c: Client, error: string | undefined) => void said.warned.push(error),
    toastAll: () => assert.fail('a floor’s theme is news for that floor, not the whole building'),
    toastFloor: (f: unknown, text: string) => void said.toasts.push({ floor: f, text }),
    floorsChanged: () => void said.floorsChanged++,
  } as unknown as Ctx;
  const c = { accountId: 'acc', peer: { name: 'Sam' } } as unknown as Client;
  return { ctx, c, said, floor };
}

test('only admins change a floor’s theme; the floor hears who did, and everyone gets the next list of floors', (t) => {
  const { root, dataDir } = office(t, [0]);
  const building = new Building(dataDir, root);

  const member = fakeCtx(building, false);
  floorThemeHandlers['floor.theme'](member.ctx, member.c, { t: 'floor.theme', floor: 'p0', palette: VTWO });
  assert.deepEqual(member.said.warned, ['Only admins can change a floor’s theme']);
  assert.equal(member.said.floorsChanged, 0);
  assert.equal(savedPalette(dataDir, 'p0'), 0);

  const admin = fakeCtx(building, true);
  floorThemeHandlers['floor.theme'](admin.ctx, admin.c, { t: 'floor.theme', floor: 'p0', palette: VTWO });
  assert.deepEqual(admin.said.warned, []);
  assert.equal(admin.said.floorsChanged, 1);
  assert.equal(savedPalette(dataDir, 'p0'), VTWO);
  assert.equal(admin.said.toasts[0].floor, admin.floor);
  assert.match(admin.said.toasts[0].text, /Sam gave the p0 floor the VTwo theme/);

  // A theme that isn't one is turned away with why.
  floorThemeHandlers['floor.theme'](admin.ctx, admin.c, { t: 'floor.theme', floor: 'p0', palette: 99 });
  assert.deepEqual(admin.said.warned, ['No such theme']);
  assert.equal(savedPalette(dataDir, 'p0'), VTWO);
});

test('the line of light stops either side of what hangs across it', () => {
  assert.deepEqual(uncut(0, 10, []), [[0, 10]]);
  assert.deepEqual(uncut(0, 10, [[2, 3], [6, 7]]), [[0, 2], [3, 6], [7, 10]]);
  // Past either end, or over the whole of it.
  assert.deepEqual(uncut(0, 10, [[-1, 1], [9, 12]]), [[1, 9]]);
  assert.deepEqual(uncut(0, 10, [[-1, 11]]), []);
  // Slivers left between two pictures aren't worth a light.
  assert.deepEqual(uncut(0, 10, [[2, 3], [3.05, 4]]), [[0, 2], [4, 10]]);
});
