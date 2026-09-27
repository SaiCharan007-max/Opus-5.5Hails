/** Physical road/city geometry shared by world generation and rendering. */
export const BLOCK_SPACING = 120;
export const GRID_W = 9;
export const GRID_H = 7;

export const CITY_WIDTH = GRID_W * BLOCK_SPACING;
export const CITY_HEIGHT = GRID_H * BLOCK_SPACING;

/** Half the asphalt width of a road, keyed by lanes-per-direction. */
export function roadHalfWidth(lanes: number): number {
  return lanes >= 2 ? 10 : 6.5;
}

export const SIDEWALK_WIDTH = 3.5;

/** Southern shoreline: everything below this y is sea. */
export const SHORELINE_Y = CITY_HEIGHT + 28;
