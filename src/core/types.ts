export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export type DistrictKind =
  | "downtown"
  | "residential"
  | "industrial"
  | "old_town"
  | "suburbs"
  | "harbor"
  | "financial"
  | "entertainment";

export type BuildingKind =
  | "home_apartment"
  | "home_house"
  | "office"
  | "shop"
  | "restaurant"
  | "hospital"
  | "police_station"
  | "fire_station"
  | "park"
  | "warehouse"
  | "government"
  | "parking"
  | "school"
  | "bank";

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}`;
}

/** Reset the global id counter — used only by tests/save-load to keep ids reproducible. */
export function resetIdCounter(): void {
  idCounter = 0;
}
