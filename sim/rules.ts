// Modelled rules for the offline arena. The live server (play.joinbuilders.org) is
// authoritative and does not publish these numbers. Values that the client or the
// repository reveals are marked "known"; everything else is an assumption chosen to be
// plausible. Strategy rankings should be checked under the variants at the bottom.

export const DT = 0.05 // physics step (s)
export const DECIDE_EVERY = 2 // a bot sees an observation and acts every N physics steps

export const MATCH = {
  mechs: 16, // known: HUD shows alive / config.match.mechs, the old bot assumed 16
  maxTime: 330,
  npcs: 36,
  crates: 70,
  groundWeapons: 36,
  groundCubes: 170,
  spawnSeparation: 70,
}

export const MECH = {
  height: 9, radius: 2, muzzle_height: 7, min_pitch: -1.4, max_pitch: 1.4, // known (bot config usage)
  hp: 1400, // known: default track health
  walk: 11, boost: 19, // m/s
  energy: 100, regen: 14, boostCost: 22, jetCost: 30, jumpSpeed: 9, gravity: 25,
  turnRate: 7, pitchRate: 4, // rad/s
  sight: 220, closeSense: 10, // m
}

export const CUBES = {
  size_per_cube: 0.05, // known config key; value from the fixtures
  perOffer: 3, // cubes per upgrade offer
  hpPerCube: 25, // max hp and healing per cube
  collectRadius: 3.5,
  dropOnDeath: 3, // on top of the victim's own cubes
  npc: 2, crate: 1,
}

export const SUPPLY = { times: [55, 125, 195], landsIn: 12, radius: 6, claim: 3, cubes: 6 }

export type WeaponKind = "gun" | "laser" | "lightning" | "mortar"
export const WEAPONS: Record<WeaponKind, any> = {
  gun: { range: 180, speed: 252, mag: 15, damage: 36, cooldown: 0.18, reload: 2.2, spread: 0.012 },
  laser: { range: 165, charge: 0.65, damage: 270, cooldown: 1.4 },
  lightning: { range: 48, cone_deg: 34, energy: 24, damage: 150, cooldown: 0.8, chain: 0 },
  mortar: { range: 220, speed: 72, gravity: 30, damage: 280, splash: 7, cooldown: 3 },
}

export const NPC = { height: 4, radius: 1.5, hp: 260, damage: 14, cooldown: 0.55, speed: 4, aggro: 32, leash: 70, bulletSpeed: 150, spread: 0.05 }
export const CRATE = { height: 3, radius: 1.5, hp: 180 }
export const PICKUP_RADIUS = 5 // known config key; value from fixtures

// Rear hits deal extra damage (the client renders a "rear" flag on hits).
export const REAR_MULT = 1.3

// Zone: each stage waits, then shrinks to `radius` by `end`. Damage per second outside.
export const ZONE = {
  radius0: 420,
  stages: [
    { start: 40, end: 70, radius: 250, dps: 20 },
    { start: 100, end: 125, radius: 150, dps: 35 },
    { start: 150, end: 170, radius: 90, dps: 55 },
    { start: 190, end: 207, radius: 52, dps: 80 },
    { start: 225, end: 240, radius: 28, dps: 120 },
    { start: 255, end: 272, radius: 10, dps: 180 },
    { start: 290, end: 310, radius: 0.5, dps: 260 },
  ],
}

export const SOUND = { step: 38, sneak: 14, boost: 90, gun: 300, laser: 220, laser_charge: 55, lightning: 170, mortar: 320, reload: 28, near: 55, mid: 130 }

export type Upgrade = { id: string; apply(m: any): void }
export const UPGRADES: Record<string, (m: any) => void> = {
  plating: (m) => { m.maxHp *= 1.15; m.hp += m.maxHp * 0.13 },
  armor: (m) => { m.armor *= 0.9 },
  nanites: (m) => { m.regenHp += 7 },
  servos: (m) => { m.speedMult *= 1.1 },
  sensors: (m) => { m.senseMult *= 1.25 },
  capacitor: (m) => { m.maxEnergy += 30 },
  reactor: (m) => { m.regenMult *= 1.35 },
  jets: (m) => { m.boostCostMult *= 0.75 },
  gyros: (m) => { m.turnMult *= 1.3 },
  gun_damage: (m) => { m.gun.damage *= 1.15 },
  gun_rate: (m) => { m.gun.cooldown *= 0.85 },
  gun_mag: (m) => { m.gun.mag = Math.round(m.gun.mag * 1.4) },
  gun_velocity: (m) => { m.gun.speed *= 1.2; m.gun.range *= 1.1 },
  laser_damage: (m) => { m.mods.laser_damage = (m.mods.laser_damage ?? 1) * 1.2 },
  laser_charge: (m) => { m.mods.laser_charge = (m.mods.laser_charge ?? 1) * 0.8 },
  laser_pierce: (m) => { m.mods.laser_pierce = 1 },
  lightning_efficiency: (m) => { m.mods.lightning_energy = (m.mods.lightning_energy ?? 1) * 0.75 },
  lightning_range: (m) => { m.mods.lightning_range = (m.mods.lightning_range ?? 1) * 1.2 },
  lightning_chain: (m) => { m.mods.lightning_chain = (m.mods.lightning_chain ?? 0) + 1 },
  mortar_reload: (m) => { m.mods.mortar_cooldown = (m.mods.mortar_cooldown ?? 1) * 0.8 },
  mortar_velocity: (m) => { m.mods.mortar_speed = (m.mods.mortar_speed ?? 1) * 1.15 },
  mortar_splash: (m) => { m.mods.mortar_splash = (m.mods.mortar_splash ?? 1) * 1.3 },
}

/** Rule variants used to check that a strategy ranking is not an artifact of one guess. */
export const VARIANTS: Record<string, (r: RuleSet) => void> = {
  base: () => {},
  // Cubes barely matter: fewer upgrades, no health.
  weakCubes: (r) => { r.cubes.perOffer = 6; r.cubes.hpPerCube = 0 },
  // Cubes snowball: an upgrade every two, more health each.
  strongCubes: (r) => { r.cubes.perOffer = 2; r.cubes.hpPerCube = 45 },
  // Short time-to-kill: twice the weapon damage.
  lethal: (r) => { for (const w of Object.values(r.weapons)) w.damage *= 2 },
  // Harsh storm and a faster schedule.
  fastZone: (r) => { for (const s of r.zone.stages) { s.start *= 0.8; s.end *= 0.8; s.dps *= 1.5 } },
}

export type RuleSet = {
  cubes: typeof CUBES; weapons: typeof WEAPONS; zone: typeof ZONE; match: typeof MATCH
  mech: typeof MECH; supply: typeof SUPPLY; npc: typeof NPC
}

export function ruleSet(variant = "base"): RuleSet {
  const r: RuleSet = JSON.parse(JSON.stringify({ cubes: CUBES, weapons: WEAPONS, zone: ZONE, match: MATCH, mech: MECH, supply: SUPPLY, npc: NPC }))
  const apply = VARIANTS[variant]
  if (!apply) throw new Error(`unknown rule variant ${variant}`)
  apply(r)
  return r
}

export function helloConfig(r: RuleSet) {
  return {
    mech: { height: r.mech.height, radius: r.mech.radius, muzzle_height: r.mech.muzzle_height, min_pitch: r.mech.min_pitch, max_pitch: r.mech.max_pitch },
    cubes: { size_per_cube: r.cubes.size_per_cube },
    crates: { height: CRATE.height, radius: CRATE.radius },
    npc: { height: r.npc.height, radius: r.npc.radius },
    loot: { pickup_radius: PICKUP_RADIUS },
    match: { mechs: r.match.mechs },
    weapons: r.weapons,
  }
}
