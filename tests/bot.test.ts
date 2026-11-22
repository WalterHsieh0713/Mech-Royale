import assert from "node:assert/strict"
import { test } from "node:test"
import { makeBot } from "../bot.ts"
import { GameMap } from "../map.ts"
import { finalDuel, flatArena, hello, hiddenCrate, observation, passingMech, seedRandom } from "./arena-fixtures.ts"

function fixtureBot(options = {}) {
  const { world, terrain } = flatArena()
  return makeBot({ ...hello, ...options }, new GameMap(world, terrain), seedRandom(hello.seed))
}

test("an equipped bot stays quiet with a nearby crate in its sights", () => {
  const action = fixtureBot().act(hiddenCrate())
  assert.deepEqual(action.fire, [false, false])
  assert.equal(action.boost, false)
})

test("an under-equipped bot can choose to farm the same crate in safety", () => {
  const obs = hiddenCrate()
  obs.self.weapons[1] = null
  const action = fixtureBot().act(obs)
  assert.deepEqual(action.fire, [true, false])
})

test("a charged laser stays held while concealing the mech", () => {
  const obs = hiddenCrate()
  const laser = obs.self.weapons[1]
  assert.ok(laser)
  laser.charge = 1
  const action = fixtureBot().act(obs)
  assert.deepEqual(action.fire, [false, true])
})

test("an unknown opening lobby does not trigger a shot at a passing opponent", () => {
  const action = fixtureBot().act(passingMech())
  assert.deepEqual(action.fire, [false, false])
})

test("explicit practice opts into the more aggressive profile", () => {
  const action = fixtureBot({ practice: true }).act(passingMech())
  assert.deepEqual(action.fire, [true, false])
})

test("an aligned visible final opponent can be engaged before it returns fire", () => {
  const action = fixtureBot({ alive_includes_self: true }).act(finalDuel())
  assert.deepEqual(action.fire, [true, false])
  assert.equal(action.boost, false)
  assert.ok(action.move.every(Number.isFinite))
})

test("a fully charged laser releases on an aligned final opponent", () => {
  const obs = finalDuel()
  obs.self.weapons[1] = { kind: "laser", charge: 1, cooldown: 0, stats: { charge: 1, range: 165 } }
  assert.equal(fixtureBot({ alive_includes_self: true }).act(obs).fire[1], false)

  obs.self.aim[1] += 0.15
  assert.equal(fixtureBot({ alive_includes_self: true }).act(obs).fire[1], true)
})

test("a wall between the mech and the final opponent prompts a move to a clear angle", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [9, -8, 13, -8, 13, 8, 9, 8], base: 0, top: 16 })
  const bot = makeBot({ ...hello, alive_includes_self: true }, new GameMap(world, terrain), seedRandom(hello.seed))
  const action = bot.act(finalDuel())
  assert.ok(Math.abs(action.move[1]) > 0.4)
  assert.deepEqual(action.fire, [false, false])
})

test("collects a useful quiet upgrade in reach, while keeping low energy for movement", () => {
  const obs = observation({ pickups: [{ id: 28, kind: "laser", pos: [3.5, 0, 0] }] })
  obs.self.energy = 18
  const action = fixtureBot().act(obs)
  assert.equal(action.take, 28)
  assert.deepEqual(action.fire, [false, false])
  assert.equal(action.boost, false)
})

test("a closing circle cancels a detour toward the same useful weapon", () => {
  const pickups: ReturnType<typeof observation>["pickups"] = [{ id: 28, kind: "laser", pos: [24, 0, 0] }]
  const open = observation({ pickups })
  const closing = observation({
    pickups,
    zone: {
      center: [0, 0], radius: 90, next_center: [-20, 0], next_radius: 23,
      shrink_start: 10.5, shrink_end: 13,
    },
  })
  assert.ok(fixtureBot().act(open).move[0] > 0.3)
  const action = fixtureBot().act(closing)
  assert.ok(action.move[0] <= 0, "the mech should not head east toward the loot")
  assert.equal(action.take, undefined)
})

test("footsteps make a marginal upgrade in that direction less attractive", () => {
  const quiet = observation({ pickups: [{ id: 28, kind: "laser", pos: [24, 0, 0] }] })
  quiet.self.weapons[1] = { kind: "mortar", cooldown: 0, stats: { range: 160 } }
  const contested = { ...quiet, sounds: [{ kind: "step", bearing: 0, dist: "near" }] }
  assert.ok(fixtureBot().act(quiet).move[0] > 0.3)
  const action = fixtureBot().act(contested)
  assert.ok(action.move[0] < 0.3, "the mech should give up the eastward detour")
  assert.deepEqual(action.fire, [false, false])
})

test("an urgent rotation can dodge toward safety when a shot crosses its path", () => {
  const rotating = observation({
    zone: {
      center: [0, 0], radius: 90, next_center: [60, 0], next_radius: 30,
      shrink_start: 10, shrink_end: 13,
    },
  })
  const path = fixtureBot().act(rotating).move
  rotating.projectiles = [{ kind: "gun", pos: [-12, -12, 4.5], vel: [60, 60, 0] }]
  const dodge = fixtureBot().act(rotating).move
  assert.ok(dodge[0] > 0.5 && dodge[1] < -0.5)
  assert.notDeepEqual(dodge, path)
  rotating.projectiles[0].pos[2] = 40
  assert.deepEqual(fixtureBot().act(rotating).move, path)
})

test("seeded mixed observations produce identical legal movement and trigger commands", () => {
  const replay = () => {
    const bot = fixtureBot({ alive_includes_self: true })
    return [observation(), hiddenCrate(), passingMech(), observation(), finalDuel()].map((obs, i) => {
      obs.tick += i
      obs.t += i / 10
      const action = bot.act(obs)
      assert.ok(action.move.every(Number.isFinite))
      assert.ok(Math.hypot(...action.move) <= 1.001)
      assert.equal(typeof action.boost, "boolean")
      assert.equal(action.fire.length, 2)
      assert.ok(action.fire.every((value: unknown) => typeof value === "boolean"))
      return action
    })
  }
  assert.deepEqual(replay(), replay())
})
