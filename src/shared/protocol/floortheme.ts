// A floor's theme: how it's painted (one of FLOOR_PALETTES), picked by an admin from ☰ → Floor theme.
// Everyone hears it in the next `floors` list, whose FloorInfo.palette says each floor's.

export type FloorThemeClientMsg =
  /** Paint `floor` in theme `palette`, an index into FLOOR_PALETTES (admins only). */
  { t: 'floor.theme'; floor: string; palette: number };
