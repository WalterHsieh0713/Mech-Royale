import assert from "node:assert/strict"
// Decisions must not depend on machine speed in tests.
process.env.MR_PLAN_BUDGET = "off"
// These tests describe the survivor profile unless they name another.
process.env.MR_STRATEGY ??= "survivor"
import { test } from "node:test"
import { GameMap } from "../map.ts"
import { flatArena } from "./arena-fixtures.ts"

test("a walkable shortcut cannot cross a high-risk area the search avoided", () => {
  const { world, terrain } = flatArena()
  const map = new GameMap(world, terrain)
  const risk = (x: number, y: number) => Math.abs(x) < 10 && Math.abs(y) < 10 ? 25 : 0
  const direct = map.planPath(-50, 0, 50, 0)
  const safer = map.planPath(-50, 0, 50, 0, 14_000, risk)
  assert.equal(direct.status, "reached")
  assert.equal(safer.status, "reached")
  assert.equal(map.routeRisk(-50, 0, direct.points, risk).peak, 25)
  assert.equal(map.routeRisk(-50, 0, safer.points, risk).peak, 0)
  assert.equal(map.canShortcut(-50, 0, safer.points, risk), false)
})

test("a route toward loot across a solid barrier is incomplete", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [-6, -100, 6, -100, 6, 100, -6, 100], base: 0, top: 16 })
  const map = new GameMap(world, terrain)
  const route = map.planPath(-50, 0, 50, 0, 14_000)
  assert.equal(route.status, "partial")
  assert.ok(route.points.length > 0)
  let previous: [number, number] = [-50, 0]
  for (const point of route.points) {
    assert.ok(map.walkLine(...previous, ...point), "the partial route must still be walkable")
    previous = point
  }
  assert.ok(previous[0] < -6)
})

test("a blocked start has no reachable first waypoint", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [-36, -36, 36, -36, 36, 36, -36, 36], base: 0, top: 16 })
  const map = new GameMap(world, terrain)
  assert.deepEqual(map.planPath(0, 0, 70, 0), { status: "unreachable", points: [] })
})
