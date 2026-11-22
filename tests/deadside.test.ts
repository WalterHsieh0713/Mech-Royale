import assert from "node:assert/strict"
import { test } from "node:test"
import { makeBot } from "../bot.ts"
import { GameMap } from "../map.ts"
import { rotationEntry, rotationPressure, zoneMargin } from "../strategy.ts"
import type { Point, Zone } from "../strategy.ts"
import { flatArena, hello, observation, seedRandom } from "./arena-fixtures.ts"

const slowShift: Zone = {
  center: [0, 0], radius: 90, next_center: [25, 0], next_radius: 40,
  shrink_start: 28, shrink_end: 34,
}

test("a shifted ring has less incoming playable area on its near-tangent side", () => {
  const west = rotationPressure(slowShift, [-9, 0])
  const south = rotationPressure(slowShift, [25, -34])
  const east = rotationPressure(slowShift, [59, 0])
  assert.ok(east < south && south < west)
  const concentric = { ...slowShift, center: slowShift.next_center }
  assert.equal(rotationPressure(concentric, [-9, 0]), rotationPressure(concentric, [59, 0]))
})

test("routes to the same goal use the pressure at their first boundary crossing", () => {
  const start: Point = [25, -65]
  const goal: Point = [25, 0]
  const east = rotationEntry(slowShift, start, [[70, -50], [70, 0], [59, 0], goal])
  const west = rotationEntry(slowShift, start, [[-20, -50], [-20, 0], goal])
  assert.deepEqual(east, [65, 0])
  assert.deepEqual(west, [-15, 0])
  assert.ok(east && west && rotationPressure(slowShift, east) < rotationPressure(slowShift, west))

  const concentric = { ...slowShift, center: slowShift.next_center }
  assert.ok(east && west && rotationPressure(concentric, east) === rotationPressure(concentric, west))
})

test("the first entry is found even when neither endpoint of the segment is inside", () => {
  const start: Point = [70, 0]
  assert.deepEqual(rotationEntry(slowShift, start, [start, [-20, 0], [25, 0]]), [65, 0])
  assert.equal(rotationEntry(slowShift, [70, 40], [[-20, 40]]), null)
  assert.equal(rotationEntry(slowShift, [59, 0], [[70, 0], [25, 0]]), null)
})

function rotationFrame(zone: Zone, heardFootsteps: boolean) {
  const frame = observation({
    zone, sounds: heardFootsteps ? [{ kind: "step", dist: "near", bearing: 1.3 }] : [],
  })
  frame.self.pos = [0, -52, 0]
  frame.self.energy = 38
  return frame
}

function createFixtureBot() {
  const { world, terrain } = flatArena()
  return makeBot(hello, new GameMap(world, terrain), seedRandom(hello.seed))
}

test("early rotation follows the chosen crossing even when the goal has a walkable shortcut", () => {
  const zone: Zone = { ...slowShift, radius: 60, next_center: [35, 0], next_radius: 25 }
  const waypoint: Point = [47, -22]
  const { world, terrain } = flatArena()
  const map = new GameMap(world, terrain)
  const frame = rotationFrame(zone, false)
  frame.self.pos = [35, -30, 0]
  // Keep the destination fixed so only the choice of route can explain the move.
  map.planPath = (_sx, _sy, gx, gy, _limit, cost) => gx === 35 && gy === 0
    ? { status: "reached", points: cost ? [waypoint, zone.next_center] : [zone.next_center] }
    : { status: "unreachable", points: [] }
  assert.equal(map.canShortcut(35, -30, [waypoint, zone.next_center], () => 0), true)

  const action = makeBot(hello, map, seedRandom(hello.seed)).act(frame)
  assert.ok(action.move[0] > 0.75 && action.move[1] > 0.4)
  assert.equal(action.boost, false)
  assert.deepEqual(action.fire, [false, false])
})

test("a nearby sound bends an early rotation away from the noisy approach and the bot gets inside", () => {
  const quiet = createFixtureBot().act(rotationFrame(slowShift, false))
  const bot = createFixtureBot()
  const frame = rotationFrame(slowShift, true)
  const first = bot.act(frame)
  assert.ok(first.move[0] > quiet.move[0] + 0.1 && first.move[1] < quiet.move[1] - 0.2)
  assert.equal(first.boost, false)
  assert.deepEqual(first.fire, [false, false])

  // Drive the controller at a fixed walking speed on the flat fixture.
  let action = first
  frame.sounds = []
  for (let i = 0; i < 45; i++) {
    frame.self.pos = [frame.self.pos[0] + action.move[0], frame.self.pos[1] + action.move[1], 0]
    frame.self.vel = [action.move[0] * 10, action.move[1] * 10, 0]
    frame.tick += 6
    frame.t += 0.1
    action = bot.act(frame)
  }
  assert.ok(zoneMargin(slowShift, [frame.self.pos[0], frame.self.pos[1]], slowShift.shrink_end) >= 4)
})

test("an imminent shrink prioritizes direct progress over the noisy approach's detour", () => {
  const urgent = { ...slowShift, shrink_start: 9, shrink_end: 12 }
  const bot = createFixtureBot()
  const frame = rotationFrame(urgent, true)
  let action = bot.act(frame)
  const towardCenter = (action.move[0] * 25 + action.move[1] * 52) / Math.hypot(25, 52)
  assert.ok(towardCenter > 0.9)
  assert.equal(action.boost, true)
  assert.deepEqual(action.fire, [false, false])

  frame.sounds = []
  for (let i = 0; i < 20; i++) {
    const step = action.boost ? 1.6 : 1
    frame.self.pos = [frame.self.pos[0] + step * action.move[0], frame.self.pos[1] + step * action.move[1], 0]
    frame.self.vel = [step * action.move[0] * 10, step * action.move[1] * 10, 0]
    frame.tick += 6
    frame.t = 10 + (i + 1) / 10
    action = bot.act(frame)
  }
  assert.ok(zoneMargin(urgent, [frame.self.pos[0], frame.self.pos[1]], frame.t) >= 4)
})

test("an urgent rotation can follow a safe partial path when a solid barrier cuts off the circle", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [-6, -100, 6, -100, 6, 100, -6, 100], base: 0, top: 16 })
  const map = new GameMap(world, terrain)
  const zone: Zone = { ...slowShift, next_center: [45, 0], next_radius: 20, shrink_start: 9, shrink_end: 11 }
  const frame = rotationFrame(zone, false)
  frame.self.pos = [-50, 0, 0]
  assert.equal(map.planPath(-50, 0, ...zone.next_center).status, "partial")

  const action = makeBot(hello, map, seedRandom(hello.seed)).act(frame)
  assert.ok(action.move[0] > 0.85)
  assert.ok(map.walkLine(-50, 0, -50 + 5 * action.move[0], 5 * action.move[1]))
  assert.deepEqual(action.fire, [false, false])
})
