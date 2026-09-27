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

- **WASD / arrow keys** — move the player
- **Click an NPC** — inspect them (job, needs, money, activity, relationships, memories)
- **1 / 2 / 3 / 4 / 5** or the speed buttons — set simulation speed (1x/2x/5x/10x/50x)
- **Space** — pause/resume
- **F3** — debug overlay (planned)

### Other commands

```bash
npm run build     # type-check and production build
npm run preview   # serve the production build locally
npm test          # run the automated test suite (vitest)
```

## Project status

Phases 1–5 complete: procedural city generation, NPC simulation with
needs/schedules/utility AI and level-of-detail scaling, and a traffic/vehicle
system with congestion-aware pathfinding. See `DECISIONS.md` for what's
built and what's still ahead.
