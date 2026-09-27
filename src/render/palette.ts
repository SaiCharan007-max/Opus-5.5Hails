import type { BuildingKind, DistrictKind } from "../core/types";

export const TERRAIN = {
  countryside: 0x4f6b43,
  countrysideDark: 0x435d39,
  field: 0x6b7a45,
  sea: 0x1f4e66,
  seaDeep: 0x173d52,
  wave: 0x5f93ad,
  sand: 0xc9b98a,
  quay: 0x7d7a73,
};

export const ROAD = {
  asphalt: 0x3b3e44,
  asphaltArterial: 0x35383e,
  sidewalk: 0x9d9a91,
  curb: 0x7c7a73,
  laneWhite: 0xd9d6cc,
  laneYellow: 0xd9b94a,
  crosswalk: 0xd6d3c8,
};

/** Ground color inside blocks (plazas, lawns, yards, yards of concrete). */
export const LOT_GROUND: Record<DistrictKind, number> = {
  downtown: 0x8b8a84,
  financial: 0x93958f,
  residential: 0x5f7d4e,
  suburbs: 0x6b8d55,
  old_town: 0xa4917a,
  entertainment: 0x6f6674,
  industrial: 0x7b776b,
  harbor: 0x74797a,
};

export interface BuildingLook {
  roof: number;
  wall: number;
  accent?: number;
}

export const BUILDING_LOOK: Record<BuildingKind, BuildingLook> = {
  office: { roof: 0x9fb0c2, wall: 0x56657a, accent: 0x7a8ea6 },
  bank: { roof: 0xd8dee4, wall: 0x7e8a96, accent: 0xc8a24a },
  shop: { roof: 0xd7b377, wall: 0x9a7040, accent: 0xe05a3f },
  restaurant: { roof: 0xc76b4b, wall: 0x8a3f2a, accent: 0xf2c14e },
  home_apartment: { roof: 0xbfae93, wall: 0x8a7760, accent: 0x6e5e4b },
  home_house: { roof: 0xa65940, wall: 0xd9cdb8, accent: 0x7d3f2d },
  hospital: { roof: 0xeef1f4, wall: 0xb9c2cc, accent: 0xd6343a },
  police_station: { roof: 0x3d5d9e, wall: 0x2b406d, accent: 0xeef1f4 },
  fire_station: { roof: 0xb73b2f, wall: 0x7d261e, accent: 0xeef1f4 },
  government: { roof: 0xe6dcc3, wall: 0xb3a586, accent: 0x8aa27a },
  school: { roof: 0xd99f58, wall: 0x9c6a33, accent: 0xeef1f4 },
  warehouse: { roof: 0x8f9ba3, wall: 0x5f6a72, accent: 0xc7a13f },
  parking: { roof: 0x4a4d53, wall: 0x3a3d42 },
  park: { roof: 0x5f8f4a, wall: 0x4d7a3c },
};

/** Alternate roofs so neighborhoods of the same kind don't look like clones. */
export const HOUSE_ROOFS = [0xa65940, 0x6b7a8f, 0x8a5a44, 0x5c6b5a, 0x9b8061];
export const APARTMENT_ROOFS = [0xbfae93, 0xa99f8e, 0xc7b8a0, 0x9fa3a6];
export const OFFICE_ROOFS = [0x9fb0c2, 0xa7b5bf, 0x8fa3b8, 0xb3bcc6];

export const CAR_COLORS = [0xd9d9d9, 0x2d2f33, 0x8a1c1c, 0x1d4e89, 0xb7b9bc, 0x3f6e3b, 0xc9a227, 0x5b3a78, 0xf2efe6, 0x7a4b2a];
export const SHIRT_COLORS = [0xe06c5a, 0x5a8fe0, 0xe0c35a, 0x6cc47a, 0xc46cc4, 0xf2f2f2, 0x333333, 0x4bb3b3, 0xe09a5a, 0x8a8ad6];
export const SKIN_TONES = [0xf1c9a5, 0xd9a878, 0xb07a4f, 0x8a5a3a, 0x5e3b25];

export const FACTION_COLOR: Record<string, number> = {
  civilians: 0x9fb4c7,
  police: 0x4d7cff,
  government: 0xd4af37,
  criminals: 0xff4d4d,
  business: 0x6ee06e,
  emergency_services: 0xff9a4d,
};

export const LIGHT = {
  window: 0xffd58a,
  lamp: 0xffcf7a,
  headlight: 0xfff3d1,
  brake: 0xff2a2a,
  signalGreen: 0x3dff7a,
  signalRed: 0xff3b30,
};

/** Cheap deterministic hash so visuals are stable per entity id without touching sim RNG. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
