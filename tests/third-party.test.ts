import assert from "node:assert/strict"
import { test } from "node:test"
import { makeBot } from "../bot.ts"
import { GameMap } from "../map.ts"
import { flatArena, hello, observation, seedRandom } from "./arena-fixtures.ts"

function skirmish(t: number, victimHp: number) {
  const obs = observation({
    t,
    tick: Math.round(t * 60),
    mechs: [
      {
        id: 2, kind: "mech", pos: [42, -4, 0], vel: [0, 0, 0],
        aim: [0, 0], hp: victimHp, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false,
      },
      {
        id: 3, kind: "mech", pos: [63, -16, 0], vel: [0, 0, 0],
        aim: [Math.atan2(12, -21), 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false,
      },
    ],
  })
  obs.self.aim = [Math.atan2(-4, 42), Math.atan2(4.5 - 7, Math.hypot(42, -4))]
  return obs
}

function setup(solidCover = true, alterMap?: (map: GameMap) => void) {
  const { world, terrain } = flatArena()
  if (solidCover) world.prisms.push({ ring: [4, 4, 15, 4, 15, 18, 4, 18], base: 0, top: 16 })
  const map = new GameMap(world, terrain)
  alterMap?.(map)
  return makeBot(hello, map, seedRandom(hello.seed))
}

function nearbyGunfire(t: number) {
  const obs = skirmish(t, 600)
  obs.sounds = [{ kind: "gun", bearing: Math.atan2(-16, 63), dist: "near" }]
  return obs
}

test("a confirmed fight permits a short shot at the weakened rival and a retreat to cover", () => {
  const bot = setup()
  assert.deepEqual(bot.act(skirmish(10, 800)).fire, [false, false])

  const attack = bot.act(skirmish(10.15, 600))
  assert.deepEqual(attack.fire, [true, false])
  assert.equal(attack.boost, false)

  const retreat = bot.act(skirmish(11.7, 500))
  assert.deepEqual(retreat.fire, [false, false])
  assert.ok(retreat.move[1] > 0.4, "the mech should move north behind its escape wall")
  assert.deepEqual(bot.act(skirmish(12.2, 400)).fire, [false, false])
  assert.deepEqual(bot.act(nearbyGunfire(14)).fire, [false, false])
  assert.deepEqual(bot.act(nearbyGunfire(19.8)).fire, [true, false])
})

test("a weakened rival with no observed fighting does not justify firing", () => {
  const bot = setup()
  assert.deepEqual(bot.act(skirmish(10, 600)).fire, [false, false])
  assert.deepEqual(bot.act(skirmish(10.15, 600)).fire, [false, false])
})

test("gunfire in the attacker's direction can confirm a fight without a prior sighting", () => {
  const obs = nearbyGunfire(10)
  assert.deepEqual(setup().act(obs).fire, [true, false])
  obs.sounds[0].bearing = Math.PI / 2
  assert.deepEqual(setup().act(obs).fire, [false, false])
})

test("a confirmed fight without a nearby solid retreat stays a pass", () => {
  const bot = setup(false)
  bot.act(skirmish(10, 800))
  assert.deepEqual(bot.act(skirmish(10.15, 600)).fire, [false, false])
})

test("losing sight of the attacker immediately ends an active burst", () => {
  const bot = setup()
  bot.act(skirmish(10, 800))
  assert.equal(bot.act(skirmish(10.15, 600)).fire[0], true)
  const lost = skirmish(10.3, 560)
  lost.mechs.pop()
  const action = bot.act(lost)
  assert.deepEqual(action.fire, [false, false])
  assert.ok(action.move[1] > 0.4)
})

test("a first health reading after an unknown reading does not imply damage", () => {
  const bot = setup()
  const unknown = skirmish(10, 1400)
  Reflect.deleteProperty(unknown.mechs[0], "hp")
  bot.act(unknown)
  assert.deepEqual(bot.act(skirmish(10.15, 600)).fire, [false, false])
})

test("an invalid health reading cannot create a false drop from unchanged health", () => {
  const bot = setup()
  bot.act(skirmish(10, 600))
  bot.act(skirmish(10.05, Infinity))
  assert.deepEqual(bot.act(skirmish(10.15, 600)).fire, [false, false])
})

test("health, energy, a ready gun, and two visible rivals each matter for an elective shot", () => {
  const impairments: { name: string; apply(obs: ReturnType<typeof skirmish>): void }[] = [
    { name: "low health", apply(obs) { obs.self.hp = 900 } },
    { name: "low energy", apply(obs) { obs.self.energy = 25 } },
    { name: "reloading", apply(obs) { obs.self.weapons[0].reload = 1 } },
    { name: "gun on cooldown", apply(obs) { obs.self.weapons[0].cooldown = 1 } },
    { name: "unrelated health loss", apply(obs) { obs.mechs[1].aim = [0, 0] } },
    { name: "one rival visible", apply(obs) { obs.mechs.pop() } },
    { name: "third rival arrived", apply(obs) {
      obs.mechs.push({ ...obs.mechs[1], id: 4, pos: [60, -24, 0], aim: [0, 0] })
    } },
  ]
  for (const impairment of impairments) {
    const bot = setup()
    bot.act(skirmish(10, 800))
    const obs = skirmish(10.15, 600)
    impairment.apply(obs)
    assert.deepEqual(bot.act(obs).fire, [false, false], impairment.name)
  }
})

test("an urgent rotation prevents a new burst and ends an active one", () => {
  for (const active of [false, true]) {
    const bot = setup()
    if (active) assert.equal(bot.act(nearbyGunfire(10)).fire[0], true)
    const obs = nearbyGunfire(10.15)
    obs.zone = {
      center: [0, 0], radius: 90, next_center: [-45, 0], next_radius: 32,
      shrink_start: 10, shrink_end: 12,
    }
    const action = bot.act(obs)
    assert.deepEqual(action.fire, [false, false])
    assert.ok(action.move[0] < -0.3)
  }
})

test("an incoming shot ends the burst and triggers a dodge when there is room", () => {
  const bot = setup()
  assert.equal(bot.act(nearbyGunfire(10)).fire[0], true)
  const obs = skirmish(10.2, 600)
  obs.projectiles = [{ kind: "gun", pos: [-15, 0, 4.5], vel: [100, 0, 0] }]
  const dodge = bot.act(obs)
  assert.deepEqual(dodge.fire, [false, false])
  assert.ok(Math.abs(dodge.move[1]) > 0.9)
  assert.equal(dodge.boost, true)
  assert.deepEqual(bot.act(nearbyGunfire(10.3)).fire, [false, false])
})

test("an incoming shot ends the burst even when both dodge steps are blocked", () => {
  const bot = setup(true, map => {
    const walkLine = map.walkLine.bind(map)
    map.walkLine = (ax, ay, bx, by, clearance) => {
      if (ax === 0 && ay === 0 && bx === 0 && Math.abs(by) === 4.5) return false
      return walkLine(ax, ay, bx, by, clearance)
    }
  })
  assert.equal(bot.act(nearbyGunfire(10)).fire[0], true)
  const obs = skirmish(10.2, 600)
  obs.projectiles = [{ kind: "gun", pos: [-15, 0, 4.5], vel: [100, 0, 0] }]
  const retreat = bot.act(obs)
  assert.deepEqual(retreat.fire, [false, false])
  assert.ok(retreat.move[1] > 0.4)
  assert.deepEqual(bot.act(nearbyGunfire(10.3)).fire, [false, false])
})

test("an unseen but recently spotted third rival can still spoil the opportunity", () => {
  const bot = setup()
  const first = skirmish(10, 800)
  first.mechs.push({ ...first.mechs[1], id: 4, pos: [60, -24, 0], aim: [0, 0] })
  bot.act(first)
  assert.deepEqual(bot.act(skirmish(10.15, 600)).fire, [false, false])
})
