import { Simulation } from "./sim/Simulation";
import { Renderer } from "./render/Renderer";
import { HUD } from "./ui/HUD";
import type { Vec2 } from "./core/types";

const SEED = 1337;
const NPC_COUNT = 250;

async function main() {
  const container = document.getElementById("app")!;

  const sim = new Simulation({ seed: SEED, npcCount: NPC_COUNT });

  const renderer = new Renderer();
  await renderer.init(container);
  renderer.drawCity(sim);

  const firstHome = sim.city.buildingsOfKind("home_house")[0] ?? sim.city.buildingsOfKind("home_apartment")[0];
  const player = { pos: { x: firstHome?.x ?? 0, y: firstHome?.y ?? 0 } as Vec2, speed: 60 };

  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === " ") {
      sim.clock.paused = !sim.clock.paused;
      e.preventDefault();
    }
    if (["1", "2", "3", "4", "5"].includes(e.key)) {
      sim.clock.timeScale = [1, 2, 5, 10, 50][Number(e.key) - 1];
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  const hud = new HUD(container, (scale) => {
    if (scale === 0) {
      sim.clock.paused = true;
    } else {
      sim.clock.paused = false;
      sim.clock.timeScale = scale;
    }
  });

  let selectedNpcId: string | null = null;
  renderer.onNpcClick = (id) => {
    selectedNpcId = id;
  };
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "CANVAS") {
      // clicks on empty canvas (not caught by an NPC sprite) deselect
    }
  });

  let lastTime = performance.now();
  let fps = 60;

  function frame(now: number) {
    const dtSeconds = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    fps = fps * 0.9 + (1 / Math.max(dtSeconds, 1e-6)) * 0.1;

    let dx = 0;
    let dy = 0;
    if (keys.has("w") || keys.has("arrowup")) dy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dy += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      player.pos.x += (dx / len) * player.speed * dtSeconds;
      player.pos.y += (dy / len) * player.speed * dtSeconds;
    }

    sim.step(dtSeconds, player.pos);

    renderer.syncNPCs(sim.npcSystem.npcs.values());
    renderer.syncVehicles(sim.vehicleSystem.vehicles.values());
    renderer.drawPlayer(player.pos);
    renderer.centerCameraOn(player.pos, 2.2);

    hud.update(sim, fps);
    if (selectedNpcId) {
      const npc = sim.npcSystem.npcs.get(selectedNpcId);
      if (npc) hud.showInspector(npc, sim.city);
      else hud.hideInspector();
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose for console debugging / future dev tools.
  (window as any).__sim = sim;
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  const el = document.getElementById("app")!;
  el.innerHTML = `<pre style="color:#f66;padding:20px;">${String(err?.stack ?? err)}</pre>`;
});
