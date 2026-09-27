import { Simulation } from "./sim/Simulation";
import { Renderer } from "./render/Renderer";
import { HUD } from "./ui/HUD";
import type { Vec2 } from "./core/types";
import type { Building } from "./world/City";

const SEED = 1337;
const NPC_COUNT = 250;
const WALK_SPEED = 30;
const RUN_SPEED = 60;
const SPEED_KEYS = [1, 2, 5, 10, 50, 100];

function blocksPlayer(b: Building, x: number, y: number): boolean {
  if (b.kind === "park" || b.kind === "parking") return false;
  return Math.abs(x - b.x) < b.w / 2 + 1.5 && Math.abs(y - b.y) < b.h / 2 + 1.5;
}

async function main() {
  const container = document.getElementById("app")!;
  const sim = new Simulation({ seed: SEED, npcCount: NPC_COUNT });
  const buildings = Array.from(sim.city.buildings.values());

  const renderer = new Renderer();
  await renderer.init(container, sim);

  const downtown = Array.from(sim.city.districts.values()).find((d) => d.kind === "downtown")!;
  const spawnNode = sim.city.roads.nearestNode({ x: (downtown.minX + downtown.maxX) / 2, y: (downtown.minY + downtown.maxY) / 2 })!;
  const player = { pos: { x: spawnNode.x + 30, y: spawnNode.y } as Vec2, heading: 0 };
  renderer.snapCamera(player.pos);

  let selectedId: string | null = null;
  let selectedBuildingId: string | null = null;
  let followingId: string | null = null;

  const hud = new HUD(container, sim, {
    onSpeed: (s) => setSpeed(s),
    onFollow: (id) => follow(id),
    onSelectNpc: (id) => select(id),
    onSelectBuilding: (id) => selectBuilding(id),
    onClose: () => deselect(),
  });

  function setSpeed(s: number) {
    if (s === 0) {
      sim.clock.paused = true;
      return;
    }
    sim.clock.paused = false;
    sim.clock.timeScale = s;
  }
  function select(id: string) {
    selectedId = id;
    selectedBuildingId = null;
    renderer.selectedBuildingId = null;
    const npc = sim.npcSystem.npcs.get(id);
    if (npc) hud.showInspector(npc, followingId === id, true);
  }
  function selectBuilding(id: string) {
    selectedBuildingId = id;
    renderer.selectedBuildingId = id;
    selectedId = null;
    followingId = null;
    hud.setFollowing(null);
    const b = sim.city.buildings.get(id);
    if (b) hud.showBuilding(b, true);
  }
  function follow(id: string) {
    followingId = followingId === id ? null : id;
    hud.setFollowing(followingId ? sim.npcSystem.npcs.get(followingId)?.name ?? null : null);
    const npc = sim.npcSystem.npcs.get(id);
    if (npc) hud.showInspector(npc, followingId === id, true);
  }
  function deselect() {
    selectedId = null;
    selectedBuildingId = null;
    renderer.selectedBuildingId = null;
    followingId = null;
    hud.setFollowing(null);
    hud.hideInspector();
  }

  renderer.entities.onPersonClick = (id) => select(id);
  renderer.onBackgroundClick = (buildingId) => {
    if (buildingId) selectBuilding(buildingId);
  };
  renderer.entities.onVehicleClick = (vid) => {
    const owner = sim.vehicleSystem.vehicles.get(vid)?.ownerNpcId;
    if (owner) select(owner);
  };

  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (e.key === " ") {
      sim.clock.paused = !sim.clock.paused;
      e.preventDefault();
    } else if (e.key >= "1" && e.key <= "6") {
      setSpeed(SPEED_KEYS[Number(e.key) - 1]);
    } else if (k === "c") {
      hud.toggleChronicle();
    } else if (k === "f" && selectedId) {
      follow(selectedId);
    } else if (e.key === "F3") {
      renderer.entities.debug = !renderer.entities.debug;
      e.preventDefault();
    } else if (e.key === "Escape") {
      if (followingId) {
        followingId = null;
        hud.setFollowing(null);
      } else deselect();
    } else if (k === "=" || k === "+") renderer.zoomBy(1.2);
    else if (k === "-") renderer.zoomBy(1 / 1.2);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      renderer.zoomBy(Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  document.getElementById("loading")?.remove();

  let last = performance.now();
  let fps = 60;
  let simMs = 0;
  function frame(t: number) {
    const dt = Math.min((t - last) / 1000, 0.1);
    last = t;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    let dx = 0;
    let dy = 0;
    if (keys.has("w") || keys.has("arrowup")) dy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dy += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    if (dx || dy) {
      if (followingId) {
        followingId = null;
        hud.setFollowing(null);
      }
      const len = Math.hypot(dx, dy);
      const step = (keys.has("shift") ? RUN_SPEED : WALK_SPEED) * dt;
      const nx = player.pos.x + (dx / len) * step;
      const ny = player.pos.y + (dy / len) * step;
      if (!buildings.some((b) => blocksPlayer(b, nx, player.pos.y))) player.pos.x = nx;
      if (!buildings.some((b) => blocksPlayer(b, player.pos.x, ny))) player.pos.y = ny;
      player.heading = Math.atan2(dy, dx);
    }

    const s0 = performance.now();
    sim.step(dt, player.pos);
    simMs = simMs * 0.95 + (performance.now() - s0) * 0.05;

    let focus: Vec2 = player.pos;
    if (followingId) {
      const npc = sim.npcSystem.npcs.get(followingId);
      if (npc) {
        focus = (npc.inVehicle && npc.vehicleId ? renderer.entities.carPos(npc.vehicleId) : renderer.entities.personPos(npc.id)) ?? npc.pos;
      }
    }
    renderer.frame(sim, dt, focus, player.pos, player.heading, selectedId);

    hud.update(fps, simMs, focus, dt);
    hud.minimap.draw(sim, player.pos, renderer.viewRect(), selectedId ? sim.npcSystem.npcs.get(selectedId)?.pos : undefined);
    if (selectedId) {
      const npc = sim.npcSystem.npcs.get(selectedId);
      if (npc) hud.showInspector(npc, followingId === selectedId);
      else deselect();
    } else if (selectedBuildingId) {
      const b = sim.city.buildings.get(selectedBuildingId);
      if (b) hud.showBuilding(b);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  Object.assign(window, { __sim: sim, __select: select, __follow: follow });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  const el = document.getElementById("loading");
  if (el) el.textContent = `Failed to start: ${String(err?.message ?? err)}`;
});
