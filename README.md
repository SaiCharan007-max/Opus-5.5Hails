# Opus City

A browser-based, living city simulation. The world keeps running whether or
not the player is doing anything — NPCs have jobs, needs, schedules, cars,
and make their own decisions.

See [`DECISIONS.md`](./DECISIONS.md) for the architecture and the reasoning
behind it.

## How to run

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

### Controls

- **WASD / arrow keys** — walk (hold **Shift** to run)
- **Mouse wheel** or **+ / −** — zoom in and out
- **Click a person or a car** — inspect them (job, home, current activity, money, needs, relationships, memories)
- **F** or the **Follow** button — camera follows the selected person through their day
- **Esc** — stop following / close the inspector
- **1–6** or the speed buttons — simulation speed 1×, 2×, 5×, 10×, 50×, 100×
- **Space** — pause / resume
- **F3** — debug view: shows every NPC (including those indoors), colored by faction, faded when simulated at low detail

### Other commands

```bash
npm run build     # type-check and production build
npm run preview   # serve the production build locally
npm test          # run the automated test suite (vitest)
```

## Project status

Done so far: procedural city (districts, lots, 300+ buildings), 250 NPCs with
needs, schedules, utility AI and level-of-detail scaling, traffic with lights
and congestion-aware routing, and a full visual pass (2.5D buildings,
day/night lighting, minimap, inspector, follow camera).

Next: economy, crime and police, relationships and memory, city events,
missions, save/load, and a world chronicle. See `DECISIONS.md` for details.
