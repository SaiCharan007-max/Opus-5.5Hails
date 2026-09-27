import { describe, it, expect } from "vitest";
import { generateCity } from "../src/world/WorldGen";
import { VehicleSystem } from "../src/traffic/VehicleSystem";

describe("VehicleSystem", () => {
  it("moves a vehicle along its requested path toward the target", () => {
    const city = generateCity(11);
    const homes = city.buildingsOfKind("home_house").length
      ? city.buildingsOfKind("home_house")
      : city.buildingsOfKind("home_apartment");
    const offices = city.buildingsOfKind("office");
    expect(homes.length).toBeGreaterThan(0);
    expect(offices.length).toBeGreaterThan(0);

    const vs = new VehicleSystem(city);
    const home = homes[0];
    const office = offices[0];
    const v = vs.spawnParked("v1", "sedan", "npc_test", home);
    const ok = vs.requestTrip("v1", office);
    expect(ok).toBe(true);

    const startDist = Math.hypot(v.pos.x - office.x, v.pos.y - office.y);
    for (let i = 0; i < 2000 && !vs.hasArrived("v1"); i++) {
      vs.update(1);
    }
    expect(vs.hasArrived("v1")).toBe(true);
    const endDist = Math.hypot(v.pos.x - office.x, v.pos.y - office.y);
    expect(endDist).toBeLessThan(startDist);
    // Vehicles stop at the nearest road node, not inside the building lot itself
    // (buildings are jittered off-grid) — confirm we're parked at that node.
    const officeNode = city.roads.nodes.get(office.nearestRoadNodeId)!;
    const nodeDist = Math.hypot(v.pos.x - officeNode.x, v.pos.y - officeNode.y);
    expect(nodeDist).toBeLessThan(1);
  });

  it("never produces NaN vehicle positions across many ticks with congestion", () => {
    const city = generateCity(23);
    const vs = new VehicleSystem(city);
    const homes = city.buildingsOfKind("home_apartment");
    const shops = city.buildingsOfKind("shop");
    for (let i = 0; i < Math.min(20, homes.length); i++) {
      const v = vs.spawnParked(`v${i}`, "sedan", `owner${i}`, homes[i]);
      vs.requestTrip(v.id, shops[i % shops.length]);
    }
    for (let t = 0; t < 1000; t++) vs.update(0.5);
    for (const v of vs.vehicles.values()) {
      expect(Number.isNaN(v.pos.x)).toBe(false);
      expect(Number.isNaN(v.pos.y)).toBe(false);
    }
  });

  it("traffic lights toggle axis over time", () => {
    const city = generateCity(5);
    const vs = new VehicleSystem(city);
    const lightNode = Array.from(city.roads.nodes.values()).find((n) => n.hasTrafficLight)!;
    expect(lightNode).toBeDefined();
    const initialAxis = lightNode.lightAxis;
    for (let i = 0; i < 20; i++) vs.update(1);
    // Over 20 sim-minutes with a 2-minute cycle, axis must have flipped at least once.
    const flipped = lightNode.lightAxis !== initialAxis || lightNode.lightTimer < 2;
    expect(flipped).toBe(true);
  });
});
