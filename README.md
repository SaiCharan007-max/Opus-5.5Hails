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
- **Click a building** — see who owns it, its finances, staff and residents
- **C** or the **Chronicle** button — the World Chronicle: the city's history as it actually happened
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
npm run observe -- 1337 60   # run seed 1337 for 60 days with nobody watching; prints daily stats and the chronicle
```

## Project status

Done so far:

- Procedural city (8 districts, 300+ buildings on real lots), 250 NPCs with needs,
  schedules, utility AI and level-of-detail scaling
- Traffic with signals and congestion-aware routing
- Economy: wages, rent, customers, owners' profits, office contracts driven by an
  economic climate, bankruptcies, demand-driven business openings, evictions,
  unemployment benefits, a city council that adjusts rents
- Crime and police: crimes chosen by personality and opportunity, witnesses who may
  or may not report, evidence, real dispatch from stations, chases, arrests, jail
- Emergencies: fires (with causes) fought by fire crews, collapses answered by
  ambulances, buildings that burn down and get rebuilt
- Relationships and memory: friendships, arguments, fights, loans between friends,
  dating and marriage; capped, decaying memories
- Gangs that form among criminals, pick leaders, feud, and fall apart
- World Chronicle, live news feed, building and person inspectors

Next: missions, player economy and interactions, save/load, observer tools and
more city events. See `DECISIONS.md` for details.
