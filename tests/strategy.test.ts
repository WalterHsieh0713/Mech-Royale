import assert from "node:assert/strict"
// Decisions must not depend on machine speed in tests.
process.env.MR_PLAN_BUDGET = "off"
// These tests describe the survivor profile unless they name another.
process.env.MR_STRATEGY ??= "survivor"
import { test } from "node:test"
import { leaveBy, routeTiming } from "../strategy.ts"
import type { Point, Zone } from "../strategy.ts"

test("a loot trip that works as a pickup can fail when farming keeps the mech there", () => {
  const zone: Zone = {
    center: [0, 0], radius: 90, next_center: [0, 0], next_radius: 25,
    shrink_start: 10, shrink_end: 15,
  }
  const route: Point[] = [[60, 0], [8, 0]]
  const collect = routeTiming(zone, [0, 0], route, 10, 30)
  const farm = routeTiming(zone, [0, 0], route, 10, 30, 0, 3)
  assert.equal(collect.outsideSeconds, 0)
  assert.ok(farm.outsideSeconds > 0)
  assert.ok(farm.minMargin < 0)
})

test("a moving circle creates a finite departure deadline for a safe-looking hold", () => {
  const zone: Zone = {
    center: [0, 0], radius: 50, next_center: [40, 0], next_radius: 25,
    shrink_start: 10, shrink_end: 20,
  }
  const deadline = leaveBy(zone, [0, 0], 5, 0)
  assert.ok(deadline > 17 && deadline < 18)
  assert.equal(leaveBy(zone, [30, 0], 5, 0), Infinity)
})
