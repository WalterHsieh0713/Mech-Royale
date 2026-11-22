import assert from "node:assert/strict"
// Decisions must not depend on machine speed in tests.
process.env.MR_PLAN_BUDGET = "off"
// These tests describe the survivor profile unless they name another.
process.env.MR_STRATEGY ??= "survivor"
import { test } from "node:test"
import { ContactBeliefs } from "../belief.ts"
import { GameMap } from "../map.ts"
import { flatArena } from "./arena-fixtures.ts"

test("lost contact still influences nearby positions and fades with elapsed time", () => {
  const { world, terrain } = flatArena()
  const memory = new ContactBeliefs(new GameMap(world, terrain))
  memory.update(1, [0, 0, 0], [{ id: 2, pos: [24, 0, 0], vel: [8, 0, 0] }], [])
  const visibleRisk = memory.riskAt(24, 0)
  memory.update(3, [0, 0, 0], [], [])
  const recentRisk = memory.riskAt(24, 0)
  assert.ok(visibleRisk > recentRisk && recentRisk > 0)
  assert.ok(memory.riskAt(37, 4) > memory.riskAt(-37, 4))
  memory.update(11, [0, 0, 0], [], [])
  assert.ok(memory.riskAt(24, 0) < recentRisk)
  memory.update(17, [0, 0, 0], [], [])
  assert.equal(memory.riskAt(24, 0), 0)
  assert.equal(memory.scanBearing(0, 0), null)
})

test("a sound creates a broad direction of risk anchored where it was heard", () => {
  const { world, terrain } = flatArena()
  const memory = new ContactBeliefs(new GameMap(world, terrain))
  memory.update(1, [0, 0, 0], [], [{ bearing: 0, kind: "step", dist: "near" }])
  const east = memory.riskAt(24, 0)
  const angled = memory.riskAt(24, 8)
  assert.ok(east > angled && angled > memory.riskAt(0, 24))
  memory.update(2, [0, 25, 0], [], [])
  assert.ok(memory.riskAt(24, 0) > memory.riskAt(24, 25))
  memory.update(6, [0, 25, 0], [], [])
  assert.equal(memory.riskAt(24, 0), 0)
})

test("solid cover reduces exposure to a recently seen opponent", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [5, -15, 11, -15, 11, 15, 5, 15], base: 0, top: 16 })
  const memory = new ContactBeliefs(new GameMap(world, terrain))
  memory.update(1, [-4, 0, 0], [{ id: 2, pos: [24, 0, 0] }], [])
  assert.ok(memory.riskAt(-4, 0) < memory.riskAt(24, 28))
})
