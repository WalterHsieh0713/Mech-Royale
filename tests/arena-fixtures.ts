// These values exercise the supplied client. The official arena config is external.
export function flatArena() {
  const size = 201
  const world = {
    terrain: { nx: size, ny: size, minX: -100, minY: -100, scale: 0.01 },
    bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    prisms: [] as { ring: number[]; base: number; top: number }[],
  }
  return { world, terrain: new Int16Array(size * size) }
}

export function seedRandom(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

export const hello = {
  type: "hello",
  slot: 1,
  seed: 41,
  config: {
    mech: { height: 9, radius: 2, muzzle_height: 7, min_pitch: -1.4, max_pitch: 1.4 },
    cubes: { size_per_cube: 0.05 },
    crates: { height: 3, radius: 1.5 },
    npc: { height: 4, radius: 1.5 },
    loot: { pickup_radius: 5 },
  },
}

type Vec3 = [number, number, number]
type Vec2 = [number, number]

type Weapon = {
  kind: string
  ammo?: number
  reload?: number
  cooldown?: number
  charge?: number
  stats: {
    range: number
    speed?: number
    mag?: number
    charge?: number
  }
}

type Mech = {
  id: number
  kind: "mech" | "npc"
  pos: Vec3
  vel: Vec3
  aim: Vec2
  hp: number
  max_hp: number
  cubes: number
  weapons: string[]
  charging: boolean
}

type Observation = {
  type: "obs"
  tick: number
  t: number
  alive: number
  self: {
    pos: Vec3
    vel: Vec3
    aim: Vec2
    hp: number
    max_hp: number
    energy: number
    grounded: boolean
    cubes: number
    weapons: [Weapon, Weapon | null]
  }
  zone: {
    center: Vec2
    radius: number
    next_center: Vec2
    next_radius: number
    shrink_start: number
    shrink_end: number
  }
  mechs: Mech[]
  crates: { id: number; pos: Vec3 }[]
  pickups: { id: number; kind: string; pos: Vec3 }[]
  cubes: { id: number; pos: Vec3 }[]
  drops: { id: number; pos: Vec3; holder: number | null; lands_in: number }[]
  projectiles: { kind: string; pos: Vec3; vel: Vec3 }[]
  sounds: { kind: string; bearing: number; dist: string }[]
  events: { type: string; by?: number; bearing?: number; id?: number }[]
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    type: "obs",
    tick: 600,
    t: 10,
    alive: 16,
    self: {
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      aim: [0, 0],
      hp: 1400,
      max_hp: 1400,
      energy: 42,
      grounded: true,
      cubes: 0,
      weapons: [{ kind: "gun", ammo: 15, reload: 0, stats: { mag: 15, speed: 252, range: 180 } }, null],
    },
    zone: {
      center: [0, 0],
      radius: 90,
      next_center: [0, 0],
      next_radius: 85,
      shrink_start: 70,
      shrink_end: 85,
    },
    mechs: [],
    crates: [],
    pickups: [],
    cubes: [],
    drops: [],
    projectiles: [],
    sounds: [],
    events: [],
    ...overrides,
  }
}

export function hiddenCrate() {
  const obs = observation({ alive: 12, crates: [{ id: 200, pos: [8, 0, 0] }] })
  obs.self.aim = [0, Math.atan2(1.5 - 7, 8)]
  obs.self.weapons[1] = { kind: "laser", charge: 0, cooldown: 0, stats: { charge: 1, range: 165 } }
  return obs
}

export function passingMech() {
  const obs = observation({
    mechs: [{
      id: 2, kind: "mech", pos: [50, 0, 0], vel: [0, 0, 0], aim: [0, 0],
      hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false,
    }],
  })
  obs.self.aim = [0, Math.atan2(4.5 - 7, 50)]
  return obs
}

export function finalDuel() {
  const obs = passingMech()
  obs.alive = 2
  obs.zone = {
    center: [20, 0], radius: 58, next_center: [20, 0], next_radius: 58,
    shrink_start: 90, shrink_end: 105,
  }
  obs.self.energy = 20
  return obs
}
