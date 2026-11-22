import assert from "node:assert/strict"
// Decisions must not depend on machine speed in tests.
process.env.MR_PLAN_BUDGET = "off"
// These tests describe the survivor profile unless they name another.
process.env.MR_STRATEGY ??= "survivor"
import { test } from "node:test"
import { makeBot } from "../bot.ts"
import { GameMap } from "../map.ts"
import { syntheticTown } from "../sim/arena.ts"
import { runMatch } from "../sim/engine.ts"

test("a short simulated match runs every profile without bot errors and is reproducible", () => {
  const { world, terrain } = syntheticTown(3)
  const map = new GameMap(world, terrain)
  const names = ["survivor", "scaler", "edge", "vulture", "fragger", "placement", "anchor", "farmer", "duel"]
  const agents = Array.from({ length: 8 }, (_, i) => ({ name: names[i], make: (h: any, m: GameMap, r: () => number) => makeBot(h, m, r, names[i]) }))
  const run = () => runMatch(map, agents, 5, "base", { maxTime: 25 })
  const first = run()
  assert.equal(first.mechs.length, 8)
  assert.ok(first.mechs.every((m) => m.errors === 0), JSON.stringify(first.mechs.map((m) => [m.agent, m.errors])))
  assert.ok(first.mechs.some((m) => m.cubesTaken > 0), "somebody should have collected a cube")
  assert.deepEqual(run().mechs.map((m) => [m.place, m.cubesTaken, m.dmgDealt]), first.mechs.map((m) => [m.place, m.cubesTaken, m.dmgDealt]))
})
