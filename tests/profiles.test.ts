import assert from "node:assert/strict"
import { test } from "node:test"
import { makeBot } from "../bot.ts"
import { GameMap } from "../map.ts"
import { PROFILES, resolveProfile } from "../profile.ts"
import { finalDuel, flatArena, hello, observation, passingMech, seedRandom } from "./arena-fixtures.ts"

function fixtureBot(profile?: string, options = {}) {
  const { world, terrain } = flatArena()
  return makeBot({ ...hello, ...options }, new GameMap(world, terrain), seedRandom(hello.seed), profile)
}

const npc = (id: number, pos: [number, number, number]) => ({
  id, kind: "npc" as const, pos, vel: [0, 0, 0] as [number, number, number], aim: [0, 0] as [number, number],
  hp: 260, max_hp: 260, cubes: 0, weapons: ["gun"], charging: false,
})

test("every named profile resolves, and unknown names fall back to the default", () => {
  for (const name of Object.keys(PROFILES)) assert.equal(resolveProfile(name).name, name)
  assert.equal(resolveProfile("no-such-profile").name, resolveProfile().name)
  assert.equal(resolveProfile({ name: "edge", cubeValue: 9 }).cubeValue, 9)
})

test("a cube 40 m away is worth the walk once the area is quiet", () => {
  const obs = observation({ cubes: [{ id: 7001, pos: [40, 0, 0] }] })
  const action = fixtureBot().act(obs)
  assert.ok(action.move[0] > 0.5, `expected to head east, got ${action.move}`)
  assert.deepEqual(action.fire, [false, false])
})

test("a remembered cube stays a goal after it leaves the observation list", () => {
  const { world, terrain } = flatArena()
  world.prisms.push({ ring: [20, -6, 22, -6, 22, 6, 20, 6], base: 0, top: 20 })
  const walled = makeBot(hello, new GameMap(world, terrain), seedRandom(hello.seed))
  // Seen once, then hidden behind the wall: the bot should keep going for it.
  walled.act(observation({ cubes: [{ id: 7001, pos: [30, 0, 0] }] }))
  const later = walled.act(observation({ t: 10.2, tick: 612, cubes: [] }))
  assert.ok(later.move[0] > 0.3, `expected to keep heading east, got ${later.move}`)
})

test("farming profiles shoot a lone NPC for cubes; the default profile stays quiet", () => {
  const obs = () => {
    const o = observation({ mechs: [npc(120, [30, 0, 0])] })
    o.self.aim = [0, Math.atan2(2 - 7, 30)]
    return o
  }
  assert.equal(fixtureBot("scaler").act(obs()).fire[0], true)
  assert.equal(fixtureBot("survivor").act(obs()).fire[0], false)
})

test("an NPC shooting a healthy hidden mech gets answered", () => {
  const obs = observation({ mechs: [npc(130, [25, 0, 0])], events: [{ type: "damaged", by: 130, bearing: 0 }] })
  obs.self.aim = [0, Math.atan2(2 - 7, 25)]
  assert.equal(fixtureBot("placement").act(obs).fire[0], true)
})

test("alive counts this mech by default, so the last opponent is engaged", () => {
  assert.deepEqual(fixtureBot().act(finalDuel()).fire, [true, false])
})

test("a lobby where nobody else has died by the second circle is treated as practice", () => {
  const late = passingMech()
  late.t = 130
  late.alive = 16
  const bot = fixtureBot()
  bot.act(passingMech())
  assert.equal(bot.act(late).fire[0], true)
  const ffa = passingMech()
  ffa.t = 130
  ffa.alive = 11
  const other = fixtureBot()
  other.act(passingMech())
  assert.equal(other.act(ffa).fire[0], false)
})

test("a route off a plateau walks off the ledge instead of reporting it unreachable", () => {
  const { world, terrain } = flatArena()
  const size = world.terrain.nx
  // A 12 m plateau over x in [-40, 0] with sheer sides.
  for (let j = 0; j < size; j++) for (let i = 60; i <= 100; i++) terrain[j * size + i] = 1200
  const map = new GameMap(world, terrain)
  const route = map.planPath(-20, 0, 40, 0, 20000)
  assert.equal(route.status, "reached")
  assert.ok((route.drops ?? []).length >= 1)
  const bot = makeBot(hello, map, seedRandom(hello.seed))
  const obs = observation({
    zone: { center: [60, 0], radius: 40, next_center: [60, 0], next_radius: 30, shrink_start: 10, shrink_end: 20 },
  })
  obs.self.pos = [-20, 0, 12]
  let pos: [number, number] = [-20, 0]
  for (let k = 0; k < 80; k++) {
    obs.t = 10 + k * 0.1
    obs.tick = 600 + k
    obs.self.pos = [pos[0], pos[1], map.floorAt(...pos)]
    const action = bot.act(obs)
    pos = [pos[0] + action.move[0] * 1, pos[1] + action.move[1] * 1]
  }
  assert.ok(pos[0] > 2, `expected to leave the plateau eastward, ended at ${pos}`)
})
