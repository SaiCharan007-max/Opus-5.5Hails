/**
 * Runs a city with nobody watching and prints what actually happened:
 * daily stats plus the chronicle. Usage: npx vite-node scripts/observe.ts [seed] [days]
 */
import { Simulation } from "../src/sim/Simulation";

const seed = Number(process.argv[2] ?? 1337);
const days = Number(process.argv[3] ?? 30);
const sim = new Simulation({ seed, npcCount: 250 });
const t0 = performance.now();
const startMoney = sim.economy.moneyInCity();

for (let d = 0; d < days; d++) sim.runHeadless(1);

const ms = performance.now() - t0;
console.log(`\n=== Seed ${seed}: ${days} days simulated in ${(ms / 1000).toFixed(1)}s (${sim.ticks} ticks) ===\n`);
console.log("day  pop  empl  unemp  homeless  biz  avg$    treasury  climate  crimes  arrests");
for (const s of sim.economy.statsHistory) {
  console.log(
    [s.day, s.population, s.employed, s.unemployed, s.homeless, s.businesses, Math.round(s.avgMoney), Math.round(s.treasury), s.climate.toFixed(2), s.crimes, s.arrests]
      .map((v, i) => String(v).padStart([3, 4, 5, 6, 9, 4, 7, 10, 8, 7, 8][i]))
      .join(" "),
  );
}
const ext = sim.economy.external;
const expected = startMoney + ext.exports - ext.imports + ext.debtForgiven;
console.log(`\nMoney in city: ${Math.round(sim.economy.moneyInCity())}  expected by ledger: ${Math.round(expected)}`);
console.log(`Gangs: ${Array.from(sim.crime.gangs.values()).map((g) => `${g.name} (${g.memberIds.length})`).join(", ") || "none"}`);
console.log(`\n--- Chronicle (importance >= ${process.argv[4] ?? 0.55}) ---`);
for (const e of sim.chronicle.headlines(Number(process.argv[4] ?? 0.55))) {
  const hh = String(Math.floor(e.minute / 60)).padStart(2, "0");
  const mm = String(e.minute % 60).padStart(2, "0");
  console.log(`Day ${e.day + 1} ${hh}:${mm}  ${e.text}`);
}
