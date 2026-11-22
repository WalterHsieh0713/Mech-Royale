// Headless mechfight/1 arena. Produces the same hello/obs messages the live server sends
// (as far as the client and this repository reveal them) and applies bot actions.
import type { GameMap } from "../map.ts"
import { CRATE, DECIDE_EVERY, DT, PICKUP_RADIUS, REAR_MULT, SOUND, UPGRADES, helloConfig, ruleSet } from "./rules.ts"
import type { RuleSet, WeaponKind } from "./rules.ts"

type V3 = [number, number, number]
type Point = [number, number]
export type BotLike = { name?: string; act(obs: any): any }
export type BotFactory = (hello: any, map: GameMap, rng: () => number) => BotLike

const TAU = Math.PI * 2
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const hyp2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)
const round = (v: number, k = 100) => Math.round(v * k) / k

export function seeded(seed: number) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

interface WeaponState { kind: WeaponKind; ammo?: number; reload: number; cooldown: number; charge: number }
interface Mech {
  id: number; agent: string; bot: BotLike | null
  pos: V3; vel: V3; aim: Point; wantAim: Point | null
  hp: number; maxHp: number; energy: number; maxEnergy: number
  armor: number; regenHp: number; speedMult: number; senseMult: number; regenMult: number; boostCostMult: number; turnMult: number
  gun: any; mods: Record<string, number>
  cubes: number; cubesTaken: number; weapons: [WeaponState, WeaponState | null]; upgrades: string[]
  alive: boolean; deathT: number; place: number; deathCause: string
  kills: number; npcKills: number; crates: number; dmgDealt: number; dmgTaken: number; zoneDmg: number; supply: number
  events: any[]; lastObsT: number
  action: any; grounded: boolean; vz: number; boosting: boolean; idleEnergyT: number
  offer: { choices: { id: string }[]; expires: number } | null; pendingOffers: number
  stepT: number; boostSoundT: number; errors: number; actMs: number; actMax: number; acts: number
  timeInZoneOut: number
}
interface Npc { id: number; pos: V3; vel: V3; aim: Point; hp: number; home: Point; target: number; aggroUntil: number; cooldown: number; goal: Point; alive: boolean; senseT: number }
interface Crate { id: number; pos: V3; hp: number; alive: boolean }
interface Item { id: number; pos: V3; kind?: WeaponKind }
interface Drop { id: number; pos: V3; landT: number; holder: number | null; progress: number }
interface Projectile { kind: "gun" | "mortar"; owner: number; pos: V3; vel: V3; damage: number; travelled: number; range: number; splash: number; gravity: number }
interface Sound { kind: string; pos: V3; radius: number; t: number; source: number }

export type MatchResult = {
  seed: number; variant: string; duration: number
  mechs: {
    slot: number; agent: string; place: number; kills: number; npcKills: number; crates: number; dmgDealt: number; dmgTaken: number
    zoneDmg: number; cubes: number; cubesTaken: number; upgrades: number; supply: number; deathT: number; deathCause: string
    errors: number; actMs: number; actMax: number; outsideSeconds: number
  }[]
}

export function runMatch(map: GameMap, agents: { name: string; make: BotFactory }[], seed: number, variant = "base", options: { maxTime?: number; log?: boolean; trace?: number[] } = {}): MatchResult {
  const R: RuleSet = ruleSet(variant)
  const rng = seeded(seed * 7919 + 17)
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }
  const cfg = helloConfig(R)
  const maxTime = options.maxTime ?? R.match.maxTime
  let t = 0, tick = 0

  // Bodies collide with buildings and walls (blocked === 1); slopes are limited by the step rule.
  const wallClear = wallClearance(map)
  const wallClearAt = (x: number, y: number) => wallClear[map.idx(x, y)]
  const passable = (x: number, y: number) => wallClearAt(x, y) >= 1.4
  const inBounds = (x: number, y: number) => x > map.minX + 2 && y > map.minY + 2 && x < map.minX + map.nx - 3 && y < map.minY + map.ny - 3

  // ---- zone schedule ----
  const bx = (map.minX + map.minX + map.nx) / 2, by = (map.minY + map.minY + map.ny) / 2
  const centers: Point[] = [[bx + (rng() - 0.5) * 60, by + (rng() - 0.5) * 60]]
  const radii = [R.zone.radius0]
  for (const stage of R.zone.stages) {
    const [cx, cy] = centers[centers.length - 1]
    const slack = Math.max(0, radii[radii.length - 1] - stage.radius) * 0.85
    let next: Point = [cx, cy]
    for (let tries = 0; tries < 60; tries++) {
      const a = rng() * TAU, r = Math.sqrt(rng()) * slack
      const p: Point = [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
      if (inBounds(...p) && map.clearAt(...p) >= 3) { next = p; break }
    }
    centers.push(next)
    radii.push(stage.radius)
  }
  function zoneObs() {
    const st = R.zone.stages
    let k = st.findIndex((s) => t < s.end)
    if (k < 0) {
      const c = centers[st.length], r = radii[st.length]
      return { zone: { center: c, radius: r, next_center: c, next_radius: r, shrink_start: st[st.length - 1].start, shrink_end: st[st.length - 1].end }, dps: st[st.length - 1].dps }
    }
    return { zone: { center: centers[k], radius: radii[k], next_center: centers[k + 1], next_radius: radii[k + 1], shrink_start: st[k].start, shrink_end: st[k].end }, dps: st[Math.max(0, k - (t < st[k].start ? 1 : 0))].dps }
  }
  function zoneNow(): { c: Point; r: number; dps: number } {
    const { zone, dps } = zoneObs()
    const f = Math.max(0, Math.min(1, (t - zone.shrink_start) / Math.max(0.001, zone.shrink_end - zone.shrink_start)))
    return { c: [zone.center[0] + (zone.next_center[0] - zone.center[0]) * f, zone.center[1] + (zone.next_center[1] - zone.center[1]) * f], r: zone.radius + (zone.next_radius - zone.radius) * f, dps }
  }

  function randomSpot(within: Point, radius: number, clearance = 4, avoid: Point[] = [], separation = 0): Point {
    for (let tries = 0; tries < 400; tries++) {
      const a = rng() * TAU, r = Math.sqrt(rng()) * radius
      const p: Point = [within[0] + Math.cos(a) * r, within[1] + Math.sin(a) * r]
      if (!inBounds(...p) || map.clearAt(...p) < clearance || !map.cwalk[map.toCell(...p)]) continue
      if (avoid.some((q) => hyp2(...p, ...q) < separation) && tries < 300) continue
      return p
    }
    return [within[0], within[1]]
  }
  const z3 = (p: Point): V3 => [p[0], p[1], map.floorAt(p[0], p[1])]

  // ---- entities ----
  let nextId = 1000
  const crates: Crate[] = []
  const pickups: Item[] = []
  const cubes: Item[] = []
  const npcs: Npc[] = []
  const drops: Drop[] = []
  const projectiles: Projectile[] = []
  const sounds: Sound[] = []
  const spawnArea = R.zone.radius0 * 0.92
  for (let i = 0; i < R.match.crates; i++) crates.push({ id: 1000 + i, pos: z3(randomSpot(centers[0], spawnArea, 3)), hp: CRATE.hp, alive: true })
  nextId = 5000
  const kinds: WeaponKind[] = ["laser", "lightning", "mortar"]
  for (let i = 0; i < R.match.groundWeapons; i++) pickups.push({ id: nextId++, kind: kinds[Math.floor(rng() * 3)], pos: z3(randomSpot(centers[0], spawnArea, 3)) })
  for (let i = 0; i < R.match.groundCubes; i++) cubes.push({ id: nextId++, pos: z3(randomSpot(centers[0], spawnArea, 2.5)) })
  for (let i = 0; i < R.match.npcs; i++) {
    const home = randomSpot(centers[0], spawnArea, 4)
    npcs.push({ id: 100 + i, pos: z3(home), vel: [0, 0, 0], aim: [rng() * TAU - Math.PI, 0], hp: R.npc.hp, home, target: -1, aggroUntil: -1, cooldown: 0, goal: home, alive: true, senseT: rng() })
  }

  const weaponStats = (m: Mech, kind: WeaponKind) => {
    if (kind === "gun") return m.gun
    const s = { ...R.weapons[kind] }
    if (kind === "laser") { s.charge *= m.mods.laser_charge ?? 1; s.damage *= m.mods.laser_damage ?? 1 }
    if (kind === "lightning") { s.energy *= m.mods.lightning_energy ?? 1; s.range *= m.mods.lightning_range ?? 1; s.chain = m.mods.lightning_chain ?? 0 }
    if (kind === "mortar") { s.cooldown *= m.mods.mortar_cooldown ?? 1; s.speed *= m.mods.mortar_speed ?? 1; s.splash *= m.mods.mortar_splash ?? 1 }
    return s
  }
  const newWeapon = (kind: WeaponKind): WeaponState => kind === "gun"
    ? { kind, ammo: R.weapons.gun.mag, reload: 0, cooldown: 0, charge: 0 }
    : { kind, reload: 0, cooldown: 0, charge: 0 }

  const mechs: Mech[] = []
  const spawns: Point[] = []
  for (let slot = 0; slot < agents.length; slot++) {
    const p = randomSpot(centers[0], spawnArea * 0.95, 5, spawns, R.match.spawnSeparation)
    spawns.push(p)
    mechs.push({
      id: slot, agent: agents[slot].name, bot: null, pos: z3(p), vel: [0, 0, 0], aim: [rng() * TAU - Math.PI, 0], wantAim: null,
      hp: R.mech.hp, maxHp: R.mech.hp, energy: R.mech.energy, maxEnergy: R.mech.energy,
      armor: 1, regenHp: 0, speedMult: 1, senseMult: 1, regenMult: 1, boostCostMult: 1, turnMult: 1,
      gun: { ...R.weapons.gun }, mods: {},
      cubes: 0, cubesTaken: 0, weapons: [newWeapon("gun"), null], upgrades: [],
      alive: true, deathT: -1, place: 0, deathCause: "",
      kills: 0, npcKills: 0, crates: 0, dmgDealt: 0, dmgTaken: 0, zoneDmg: 0, supply: 0,
      events: [], lastObsT: -1, action: { move: [0, 0] }, grounded: true, vz: 0, boosting: false, idleEnergyT: 0,
      offer: null, pendingOffers: 0, stepT: 0, boostSoundT: 0, errors: 0, actMs: 0, actMax: 0, acts: 0, timeInZoneOut: 0,
    })
  }
  for (const m of mechs) {
    const hello = { type: "hello", proto: "mechfight/1", slot: m.id, seed: Math.floor(rng() * 1e9), config: cfg, map: { dir: "arena" } }
    try { m.bot = agents[m.id].make(hello, map, seeded(hello.seed)) } catch (e) { m.errors++; if (options.log) console.error(e) }
  }
  let aliveCount = mechs.length

  const scale = (m: Mech) => 1 + R.cubes.size_per_cube * m.cubes
  const mechR = (m: Mech) => R.mech.radius * scale(m)
  const mechH = (m: Mech) => R.mech.height * scale(m)
  const eye = (m: Mech) => m.pos[2] + mechH(m) - 1
  const muzzle = (m: Mech): V3 => [m.pos[0], m.pos[1], m.pos[2] + R.mech.muzzle_height]
  const emit = (kind: string, pos: V3, source: number) => sounds.push({ kind, pos: [pos[0], pos[1], pos[2]], radius: (SOUND as any)[kind] ?? 60, t, source })

  // ---- damage ----
  function kill(victim: Mech, by: Mech | null, cause: string) {
    victim.alive = false
    victim.deathT = t
    victim.place = aliveCount
    victim.deathCause = cause
    aliveCount--
    const n = victim.cubes + R.cubes.dropOnDeath
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, r = 1 + rng() * 4
      const p: Point = [victim.pos[0] + Math.cos(a) * r, victim.pos[1] + Math.sin(a) * r]
      cubes.push({ id: nextId++, pos: z3(passable(...p) ? p : [victim.pos[0], victim.pos[1]]) })
    }
    if (victim.weapons[1]) pickups.push({ id: nextId++, kind: victim.weapons[1].kind, pos: [...victim.pos] as V3 })
    if (by) { by.kills++; by.events.push({ type: "kill", target: victim.id }) }
  }
  function hurtMech(victim: Mech, amount: number, attacker: Mech | Npc | null, weapon: string, from: V3) {
    if (!victim.alive || amount <= 0) return
    const bearing = Math.atan2(from[1] - victim.pos[1], from[0] - victim.pos[0])
    const rear = attacker !== null && Math.abs(wrap(bearing - victim.aim[0])) > 1.95
    const dmg = amount * (rear ? REAR_MULT : 1) * victim.armor
    victim.hp -= dmg
    victim.dmgTaken += dmg
    victim.events.push({ type: "damaged", by: attacker ? attacker.id : null, bearing: round(bearing, 1000), amount: round(dmg), weapon, rear })
    const attackerMech = attacker && attacker.id < 100 ? attacker as Mech : null
    if (attackerMech) {
      attackerMech.dmgDealt += dmg
      attackerMech.events.push({ type: "hit", target: victim.id, amount: round(dmg), rear })
    }
    if (victim.hp <= 0) kill(victim, attackerMech, attackerMech ? attackerMech.agent : attacker ? "npc" : weapon)
  }
  function hurtNpc(n: Npc, amount: number, attacker: Mech) {
    if (!n.alive) return
    n.hp -= amount
    n.target = attacker.id
    n.aggroUntil = t + 8
    attacker.events.push({ type: "hit", target: n.id, amount: round(amount), rear: false })
    if (n.hp <= 0) {
      n.alive = false
      attacker.npcKills++
      for (let i = 0; i < R.cubes.npc; i++) cubes.push({ id: nextId++, pos: z3([n.pos[0] + (rng() - 0.5) * 3, n.pos[1] + (rng() - 0.5) * 3]) })
    }
  }
  function hurtCrate(c: Crate, amount: number, attacker: Mech) {
    if (!c.alive) return
    c.hp -= amount
    attacker.events.push({ type: "hit", target: c.id, amount: round(amount), rear: false })
    if (c.hp <= 0) {
      c.alive = false
      attacker.crates++
      pickups.push({ id: nextId++, kind: kinds[Math.floor(rng() * 3)], pos: [...c.pos] as V3 })
      for (let i = 0; i < R.cubes.crate; i++) cubes.push({ id: nextId++, pos: z3([c.pos[0] + 1.5, c.pos[1] + (rng() - 0.5) * 2]) })
    }
  }

  // Segment p->q against every target cylinder and the static map. Returns the first hit.
  type Hit = { f: number; kind: "mech" | "npc" | "crate" | "wall" | "none"; ref?: any }
  function trace(p: V3, q: V3, ownerId: number, skip?: Set<any>): Hit {
    let best: Hit = { f: 1, kind: "none" }
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]
    const L2 = dx * dx + dy * dy
    const test = (cx: number, cy: number, base: number, h: number, r: number, kind: Hit["kind"], ref: any) => {
      if (L2 < 1e-9) return
      const f = Math.max(0, Math.min(1, ((cx - p[0]) * dx + (cy - p[1]) * dy) / L2))
      if (f >= best.f) return
      const px = p[0] + dx * f - cx, py = p[1] + dy * f - cy
      if (px * px + py * py > r * r) return
      const z = p[2] + dz * f
      if (z < base - 0.3 || z > base + h + 0.3) return
      best = { f, kind, ref }
    }
    const minX = Math.min(p[0], q[0]) - 8, maxX = Math.max(p[0], q[0]) + 8, minY = Math.min(p[1], q[1]) - 8, maxY = Math.max(p[1], q[1]) + 8
    for (const m of mechs) if (m.alive && m.id !== ownerId && !skip?.has(m) && m.pos[0] > minX && m.pos[0] < maxX && m.pos[1] > minY && m.pos[1] < maxY) test(m.pos[0], m.pos[1], m.pos[2], mechH(m), mechR(m), "mech", m)
    for (const n of npcs) if (n.alive && n.id !== ownerId && !skip?.has(n) && n.pos[0] > minX && n.pos[0] < maxX && n.pos[1] > minY && n.pos[1] < maxY) test(n.pos[0], n.pos[1], n.pos[2], R.npc.height, R.npc.radius, "npc", n)
    for (const c of crates) if (c.alive && c.pos[0] > minX && c.pos[0] < maxX && c.pos[1] > minY && c.pos[1] < maxY) test(c.pos[0], c.pos[1], c.pos[2], CRATE.height, CRATE.radius, "crate", c)
    const L = Math.sqrt(L2 + dz * dz)
    const n = Math.max(1, Math.ceil(L / 0.9))
    for (let s = 1; s <= n; s++) {
      const f = s / n
      if (f >= best.f) break
      const k = map.idx(p[0] + dx * f, p[1] + dy * f)
      const z = p[2] + dz * f
      if (z < map.ground[k] - 0.2 || (z >= map.solidLo[k] && z <= map.solidHi[k])) { best = { f, kind: "wall" }; break }
    }
    return best
  }
  function applyHit(hit: Hit, damage: number, owner: Mech | Npc, weapon: string, from: V3) {
    if (hit.kind === "mech") hurtMech(hit.ref, damage, owner, weapon, from)
    else if (owner.id < 100 && hit.kind === "npc") hurtNpc(hit.ref, damage, owner as Mech)
    else if (owner.id < 100 && hit.kind === "crate") hurtCrate(hit.ref, damage, owner as Mech)
  }
  function explode(at: V3, owner: Mech, damage: number, radius: number, direct?: any) {
    for (const m of mechs) {
      if (!m.alive) continue
      const d = Math.hypot(m.pos[0] - at[0], m.pos[1] - at[1], (m.pos[2] + mechH(m) / 2) - at[2]) - mechR(m)
      const f = m === direct ? 1 : Math.max(0, 1 - Math.max(0, d) / radius) * 0.7
      if (f > 0 && (m === direct || map.los(at[0], at[1], at[2] + 0.5, m.pos[0], m.pos[1], m.pos[2] + mechH(m) / 2, 0.3))) hurtMech(m, damage * f, m === owner ? null : owner, "mortar", at)
    }
    for (const n of npcs) if (n.alive && Math.hypot(n.pos[0] - at[0], n.pos[1] - at[1]) < radius) hurtNpc(n, damage * (n === direct ? 1 : 0.6), owner)
    for (const c of crates) if (c.alive && Math.hypot(c.pos[0] - at[0], c.pos[1] - at[1]) < radius) hurtCrate(c, damage * 0.6, owner)
  }

  // ---- per-step mechanics ----
  function moveBody(pos: V3, dx: number, dy: number, speed: number, airborne: boolean, clearance = 1.4): boolean {
    const nx = pos[0] + dx * speed * DT, ny = pos[1] + dy * speed * DT
    // world.json rules: maxStep 1.5 m between neighbouring 1 m cells (about a 50 degree
    // slope). Walking off a ledge is allowed; the body then falls.
    const ok = (x: number, y: number) => {
      if (!inBounds(x, y) || wallClearAt(x, y) < clearance) return false
      const rise = map.floorAt(x, y) - pos[2]
      return airborne ? rise <= 0.2 : rise <= (map.idx(x, y) === map.idx(pos[0], pos[1]) ? 0.4 : 1.5)
    }
    if (ok(nx, ny)) { pos[0] = nx; pos[1] = ny; return true }
    if (Math.abs(dx) > 0.2 && ok(nx, pos[1])) { pos[0] = nx; return true }
    if (Math.abs(dy) > 0.2 && ok(pos[0], ny)) { pos[1] = ny; return true }
    return false
  }

  function stepMech(m: Mech) {
    const a = m.action ?? {}
    const mv: number[] = Array.isArray(a.move) && a.move.every(Number.isFinite) ? a.move : [0, 0]
    let ml = Math.hypot(mv[0], mv[1])
    const dir: Point = ml > 1e-6 ? [mv[0] / ml, mv[1] / ml] : [0, 0]
    ml = Math.min(1, ml)
    // aim
    if (Array.isArray(a.aim) && a.aim.every(Number.isFinite)) m.wantAim = [a.aim[0], Math.max(R.mech.min_pitch, Math.min(R.mech.max_pitch, a.aim[1]))]
    if (m.wantAim) {
      const rate = R.mech.turnRate * m.turnMult * DT, pr = R.mech.pitchRate * m.turnMult * DT
      const dy = wrap(m.wantAim[0] - m.aim[0]), dp = m.wantAim[1] - m.aim[1]
      m.aim = [wrap(m.aim[0] + Math.max(-rate, Math.min(rate, dy))), m.aim[1] + Math.max(-pr, Math.min(pr, dp))]
    }
    // energy and boost
    const boostCost = R.mech.boostCost * m.boostCostMult
    m.boosting = !!a.boost && ml > 0.3 && m.energy > boostCost * DT
    let speed = R.mech.walk * m.speedMult * ml
    if (m.boosting) { speed = R.mech.boost * m.speedMult; m.energy -= boostCost * DT; m.idleEnergyT = t + 0.6 }
    if (a.jump && m.grounded && m.energy > 8) { m.grounded = false; m.vz = R.mech.jumpSpeed; m.energy -= 8; m.idleEnergyT = t + 0.6 }
    if (!m.grounded) {
      if (a.boost && m.energy > 0) { m.vz += 32 * DT; m.energy -= R.mech.jetCost * m.boostCostMult * DT; m.idleEnergyT = t + 0.6 }
      m.vz -= R.mech.gravity * DT
      m.pos[2] += m.vz * DT
    }
    if (t >= m.idleEnergyT) m.energy = Math.min(m.maxEnergy, m.energy + R.mech.regen * m.regenMult * DT)
    m.energy = Math.max(0, m.energy)
    const before: Point = [m.pos[0], m.pos[1]]
    if (speed > 0) moveBody(m.pos, dir[0], dir[1], speed, !m.grounded)
    const floor = map.floorAt(m.pos[0], m.pos[1])
    if (m.grounded) {
      if (floor < m.pos[2] - 1.6) { m.grounded = false; m.vz = 0 } else m.pos[2] = floor
    } else if (m.pos[2] <= floor) { m.pos[2] = floor; m.grounded = true; m.vz = 0 }
    m.vel = [(m.pos[0] - before[0]) / DT, (m.pos[1] - before[1]) / DT, m.grounded ? 0 : m.vz]
    // footstep / boost sounds
    const hs = Math.hypot(m.vel[0], m.vel[1])
    if (m.boosting && t >= m.boostSoundT) { emit("boost", m.pos, m.id); m.boostSoundT = t + 0.3 }
    else if (hs > 2 && m.grounded && t >= m.stepT) { emit(hs > 7 ? "step" : "sneak", m.pos, m.id); m.stepT = t + 0.45 }
    if (m.regenHp > 0) m.hp = Math.min(m.maxHp, m.hp + m.regenHp * DT)

    // weapons
    const fire: boolean[] = Array.isArray(a.fire) ? a.fire : [false, false]
    for (let s = 0; s < 2; s++) {
      const w = m.weapons[s]
      if (!w) continue
      w.cooldown = Math.max(0, w.cooldown - DT)
      const st = weaponStats(m, w.kind)
      if (w.kind === "gun") {
        if (w.reload > 0) { w.reload -= DT; if (w.reload <= 0) { w.reload = 0; w.ammo = st.mag } }
        if (a.reload && w.reload <= 0 && (w.ammo ?? 0) < st.mag) { w.reload = st.reload; emit("reload", m.pos, m.id) }
        if (fire[s] && w.reload <= 0 && w.cooldown <= 0) {
          if ((w.ammo ?? 0) <= 0) { w.reload = st.reload; emit("reload", m.pos, m.id); continue }
          w.ammo!--
          w.cooldown = st.cooldown
          const yaw = m.aim[0] + gauss() * st.spread, pitch = m.aim[1] + gauss() * st.spread
          const v: V3 = [Math.cos(pitch) * Math.cos(yaw) * st.speed, Math.cos(pitch) * Math.sin(yaw) * st.speed, Math.sin(pitch) * st.speed]
          projectiles.push({ kind: "gun", owner: m.id, pos: muzzle(m), vel: v, damage: st.damage, travelled: 0, range: st.range, splash: 0, gravity: 0 })
          emit("gun", m.pos, m.id)
        }
      } else if (w.kind === "laser") {
        if (fire[s] && w.cooldown <= 0) {
          if (w.charge === 0) emit("laser_charge", m.pos, m.id)
          w.charge = Math.min(st.charge, w.charge + DT)
        } else if (!fire[s] && w.charge > 0) {
          const frac = w.charge / st.charge
          w.charge = 0
          if (frac >= 0.25) {
            w.cooldown = st.cooldown
            emit("laser", m.pos, m.id)
            const p = muzzle(m)
            const d: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
            const q: V3 = [p[0] + d[0] * st.range, p[1] + d[1] * st.range, p[2] + d[2] * st.range]
            const skip = new Set<any>()
            for (let pierce = 0; pierce <= (m.mods.laser_pierce ?? 0); pierce++) {
              const hit = trace(p, q, m.id, skip)
              if (hit.kind === "none" || hit.kind === "wall") break
              applyHit(hit, st.damage * Math.min(1, frac), m, "laser", p)
              skip.add(hit.ref)
            }
          }
        }
      } else if (w.kind === "lightning") {
        if (fire[s] && w.cooldown <= 0 && m.energy >= st.energy) {
          m.energy -= st.energy
          m.idleEnergyT = t + 0.6
          w.cooldown = st.cooldown
          emit("lightning", m.pos, m.id)
          const half = (st.cone_deg * Math.PI) / 360
          const p = muzzle(m)
          const candidates: { ref: any; d: number; npc: boolean }[] = []
          for (const o of mechs) if (o.alive && o !== m) candidates.push({ ref: o, d: hyp2(o.pos[0], o.pos[1], m.pos[0], m.pos[1]), npc: false })
          for (const n of npcs) if (n.alive) candidates.push({ ref: n, d: hyp2(n.pos[0], n.pos[1], m.pos[0], m.pos[1]), npc: true })
          const inCone = candidates.filter(({ ref, d }) => d < st.range && Math.abs(wrap(Math.atan2(ref.pos[1] - m.pos[1], ref.pos[0] - m.pos[0]) - m.aim[0])) < half
            && map.los(p[0], p[1], p[2], ref.pos[0], ref.pos[1], ref.pos[2] + 3, 1)).sort((x, y) => x.d - y.d)
          let prev = inCone[0]
          const struck = new Set<any>()
          for (let c = 0; prev && c <= st.chain; c++) {
            struck.add(prev.ref)
            if (prev.npc) hurtNpc(prev.ref, st.damage, m); else hurtMech(prev.ref, st.damage, m, "lightning", m.pos)
            const from = prev.ref.pos
            prev = candidates.filter((x) => !struck.has(x.ref) && hyp2(x.ref.pos[0], x.ref.pos[1], from[0], from[1]) < 16).sort((x, y) => x.d - y.d)[0]
          }
        }
      } else if (w.kind === "mortar") {
        if (fire[s] && w.cooldown <= 0) {
          w.cooldown = st.cooldown
          emit("mortar", m.pos, m.id)
          const v: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]) * st.speed, Math.cos(m.aim[1]) * Math.sin(m.aim[0]) * st.speed, Math.sin(m.aim[1]) * st.speed]
          projectiles.push({ kind: "mortar", owner: m.id, pos: [m.pos[0], m.pos[1], m.pos[2] + mechH(m) + 0.5], vel: v, damage: st.damage, travelled: 0, range: 600, splash: st.splash, gravity: st.gravity })
        }
      }
    }
    // pickups
    if (typeof a.take === "number") {
      const p = pickups.find((q) => q.id === a.take)
      const reason = !p ? "gone" : hyp2(p.pos[0], p.pos[1], m.pos[0], m.pos[1]) > PICKUP_RADIUS || Math.abs(p.pos[2] - m.pos[2]) > 4 ? "far"
        : m.weapons.some((w) => w?.kind === p.kind) ? "have" : m.weapons[1] && a.drop !== 1 ? "full" : ""
      if (reason) m.events.push({ type: "take_failed", id: a.take, reason })
      else if (p) {
        if (m.weapons[1]) { pickups.push({ id: nextId++, kind: m.weapons[1].kind, pos: [...m.pos] as V3 }); m.events.push({ type: "dropped", kind: m.weapons[1].kind }) }
        m.weapons[1] = newWeapon(p.kind!)
        pickups.splice(pickups.indexOf(p), 1)
        m.events.push({ type: "took", kind: p.kind, slot: 1 })
      }
      a.take = undefined
    }
    // upgrade choice
    if (m.offer && (typeof a.pick === "number" || t >= m.offer.expires)) {
      const index = typeof a.pick === "number" && a.pick >= 0 && a.pick < m.offer.choices.length ? a.pick : 0
      const id = m.offer.choices[index].id
      UPGRADES[id](m)
      m.upgrades.push(id)
      m.events.push({ type: "upgrade", id })
      m.offer = null
      a.pick = undefined
    }
    if (!m.offer && m.pendingOffers > 0) {
      m.pendingOffers--
      const ids = Object.keys(UPGRADES)
      const choices: { id: string }[] = []
      while (choices.length < 3) { const id = ids[Math.floor(rng() * ids.length)]; if (!choices.some((c) => c.id === id)) choices.push({ id }) }
      m.offer = { choices, expires: t + 8 }
    }
  }

  function stepNpc(n: Npc) {
    n.cooldown = Math.max(0, n.cooldown - DT)
    if (t >= n.senseT) {
      n.senseT = t + 0.5
      if (n.target < 0 || t > n.aggroUntil) {
        n.target = -1
        let best = R.npc.aggro
        for (const m of mechs) {
          if (!m.alive) continue
          const d = hyp2(m.pos[0], m.pos[1], n.pos[0], n.pos[1])
          if (d < best && map.see(n.pos[0], n.pos[1], n.pos[2] + 3.5, m.pos[0], m.pos[1], m.pos[2] + 5)) { best = d; n.target = m.id; n.aggroUntil = t + 4 }
        }
      }
    }
    const tg = n.target >= 0 ? mechs[n.target] : null
    if (tg && tg.alive && hyp2(n.home[0], n.home[1], n.pos[0], n.pos[1]) < R.npc.leash && hyp2(tg.pos[0], tg.pos[1], n.pos[0], n.pos[1]) < 75) {
      const yaw = Math.atan2(tg.pos[1] - n.pos[1], tg.pos[0] - n.pos[0])
      n.aim = [yaw, 0]
      const d = hyp2(tg.pos[0], tg.pos[1], n.pos[0], n.pos[1])
      if (d > 25) moveBody(n.pos, Math.cos(yaw), Math.sin(yaw), R.npc.speed, false, 1.6)
      if (n.cooldown <= 0) {
        n.cooldown = R.npc.cooldown
        const p: V3 = [n.pos[0], n.pos[1], n.pos[2] + 3]
        const tz = tg.pos[2] + mechH(tg) / 2
        const pitch = Math.atan2(tz - p[2], d) + gauss() * R.npc.spread
        const ya = yaw + gauss() * R.npc.spread
        projectiles.push({ kind: "gun", owner: n.id, pos: p, vel: [Math.cos(pitch) * Math.cos(ya) * R.npc.bulletSpeed, Math.cos(pitch) * Math.sin(ya) * R.npc.bulletSpeed, Math.sin(pitch) * R.npc.bulletSpeed], damage: R.npc.damage, travelled: 0, range: 90, splash: 0, gravity: 0 })
        emit("gun", n.pos, n.id)
      }
    } else {
      if (tg && !tg.alive) n.target = -1
      if (hyp2(n.goal[0], n.goal[1], n.pos[0], n.pos[1]) < 1.5 || rng() < 0.004) {
        const a = rng() * TAU, r = rng() * 14
        n.goal = [n.home[0] + Math.cos(a) * r, n.home[1] + Math.sin(a) * r]
      }
      const yaw = Math.atan2(n.goal[1] - n.pos[1], n.goal[0] - n.pos[0])
      if (!moveBody(n.pos, Math.cos(yaw), Math.sin(yaw), R.npc.speed * 0.6, false, 1.6)) n.goal = n.home
      n.aim = [yaw, 0]
    }
    n.pos[2] = map.floorAt(n.pos[0], n.pos[1])
  }

  function stepProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]
      const q: V3 = [p.pos[0] + p.vel[0] * DT, p.pos[1] + p.vel[1] * DT, p.pos[2] + p.vel[2] * DT - 0.5 * p.gravity * DT * DT]
      const owner: Mech | Npc | undefined = p.owner < 100 ? mechs[p.owner] : npcs[p.owner - 100]
      const hit = trace(p.pos, q, p.owner)
      const at: V3 = [p.pos[0] + (q[0] - p.pos[0]) * hit.f, p.pos[1] + (q[1] - p.pos[1]) * hit.f, p.pos[2] + (q[2] - p.pos[2]) * hit.f]
      p.travelled += Math.hypot(q[0] - p.pos[0], q[1] - p.pos[1], q[2] - p.pos[2]) * hit.f
      if (hit.kind !== "none") {
        if (p.kind === "mortar" && owner) explode(at, owner as Mech, p.damage, p.splash, hit.kind === "wall" ? undefined : hit.ref)
        else if (owner && hit.kind !== "wall") applyHit(hit, p.damage, owner, "gun", p.pos)
        projectiles.splice(i, 1)
        continue
      }
      p.pos = q
      p.vel[2] -= p.gravity * DT
      if (p.travelled > p.range || p.pos[2] < -200) projectiles.splice(i, 1)
    }
  }

  function stepWorld() {
    const zn = zoneNow()
    for (const m of mechs) {
      if (!m.alive) continue
      if (hyp2(m.pos[0], m.pos[1], zn.c[0], zn.c[1]) > zn.r) {
        m.zoneDmg += zn.dps * DT
        m.timeInZoneOut += DT
        m.hp -= zn.dps * DT
        if (m.hp <= 0) kill(m, null, "zone")
      }
    }
    // cubes
    for (let i = cubes.length - 1; i >= 0; i--) {
      const c = cubes[i]
      for (const m of mechs) {
        if (!m.alive || Math.abs(c.pos[2] - m.pos[2]) > 4) continue
        if (hyp2(c.pos[0], c.pos[1], m.pos[0], m.pos[1]) <= R.cubes.collectRadius + mechR(m) - R.mech.radius) {
          m.cubes++; m.cubesTaken++
          m.maxHp += R.cubes.hpPerCube; m.hp += R.cubes.hpPerCube
          if (m.cubes % R.cubes.perOffer === 0) m.pendingOffers++
          cubes.splice(i, 1)
          break
        }
      }
    }
    // supply drops
    for (const time of R.supply.times) {
      if (t >= time && t - DT < time) {
        const { zone } = zoneObs()
        const spot = randomSpot(zone.next_center, Math.max(5, zone.next_radius * 0.7), 4)
        drops.push({ id: nextId++, pos: z3(spot), landT: t + R.supply.landsIn, holder: null, progress: 0 })
      }
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]
      if (t < d.landT) continue
      const inside = mechs.filter((m) => m.alive && hyp2(m.pos[0], m.pos[1], d.pos[0], d.pos[1]) <= R.supply.radius)
      const holder = inside.length === 1 ? inside[0].id : null
      if (holder !== d.holder) d.progress = 0
      d.holder = holder
      if (holder !== null) {
        d.progress += DT
        if (d.progress >= R.supply.claim) {
          const m = mechs[holder]
          for (let k = 0; k < R.supply.cubes; k++) {
            m.cubes++; m.cubesTaken++; m.maxHp += R.cubes.hpPerCube; m.hp += R.cubes.hpPerCube
            if (m.cubes % R.cubes.perOffer === 0) m.pendingOffers++
          }
          m.supply++
          m.events.push({ type: "drop", cubes: R.supply.cubes })
          drops.splice(i, 1)
        }
      }
    }
    while (sounds.length && t - sounds[0].t > 1) sounds.shift()
  }

  // ---- observations ----
  function canSee(a: Mech, pos: V3, height: number): boolean {
    const d = hyp2(a.pos[0], a.pos[1], pos[0], pos[1])
    if (d > R.mech.sight * a.senseMult) return false
    if (d < R.mech.closeSense) return true
    const e = eye(a)
    return map.see(a.pos[0], a.pos[1], e, pos[0], pos[1], pos[2] + height * 0.5) || map.see(a.pos[0], a.pos[1], e, pos[0], pos[1], pos[2] + height * 0.95)
  }
  const v3 = (p: number[]): V3 => [round(p[0]), round(p[1]), round(p[2])]
  function weaponObs(m: Mech, w: WeaponState | null) {
    if (!w) return null
    const st = weaponStats(m, w.kind)
    const o: any = { kind: w.kind, cooldown: round(w.cooldown), stats: { ...st } }
    if (w.kind === "gun") { o.ammo = w.ammo; o.reload = round(w.reload) }
    if (w.kind === "laser") o.charge = round(w.charge, 1000)
    return o
  }
  function observe(m: Mech) {
    const { zone } = zoneObs()
    const seen: any[] = []
    for (const o of mechs) {
      if (!o.alive || o === m || !canSee(m, o.pos, mechH(o))) continue
      seen.push({ id: o.id, kind: "mech", pos: v3(o.pos), vel: v3(o.vel), aim: [round(o.aim[0], 1000), round(o.aim[1], 1000)], hp: Math.ceil(o.hp), max_hp: Math.round(o.maxHp), cubes: o.cubes, weapons: o.weapons.filter(Boolean).map((w) => w!.kind), charging: o.weapons.some((w) => w?.kind === "laser" && w.charge > 0) })
    }
    for (const n of npcs) {
      if (!n.alive || hyp2(n.pos[0], n.pos[1], m.pos[0], m.pos[1]) > 160 || !canSee(m, n.pos, R.npc.height)) continue
      seen.push({ id: n.id, kind: "npc", pos: v3(n.pos), vel: [0, 0, 0], aim: [round(n.aim[0], 1000), 0], hp: Math.ceil(n.hp), max_hp: R.npc.hp, cubes: 0, weapons: ["gun"], charging: false })
    }
    const near = (p: V3, range: number) => hyp2(p[0], p[1], m.pos[0], m.pos[1]) <= range
    const visibleItem = (p: V3) => near(p, 150) && (near(p, 12) || map.see(m.pos[0], m.pos[1], eye(m), p[0], p[1], p[2] + 1))
    const heard: any[] = []
    for (const s of sounds) {
      if (s.t <= m.lastObsT || s.source === m.id) continue
      const d = hyp2(s.pos[0], s.pos[1], m.pos[0], m.pos[1])
      if (d > s.radius * m.senseMult) continue
      const kind = s.kind === "sneak" ? "step" : s.kind
      heard.push({ kind, bearing: round(wrap(Math.atan2(s.pos[1] - m.pos[1], s.pos[0] - m.pos[0]) + gauss() * 0.08), 1000), dist: d < SOUND.near ? "near" : d < SOUND.mid ? "mid" : "far" })
      if (heard.length >= 12) break
    }
    const zn = zoneNow()
    const obs = {
      type: "obs", tick, t: round(t, 1000), alive: aliveCount,
      self: {
        pos: v3(m.pos), vel: v3(m.vel), aim: [round(m.aim[0], 10000), round(m.aim[1], 10000)], hp: round(m.hp, 10), max_hp: Math.round(m.maxHp),
        energy: round(m.energy, 10), grounded: m.grounded, cubes: m.cubes, weapons: [weaponObs(m, m.weapons[0]), weaponObs(m, m.weapons[1])],
        stats: { muzzle_height: R.mech.muzzle_height }, upgrades: [...m.upgrades], in_zone: hyp2(m.pos[0], m.pos[1], zn.c[0], zn.c[1]) <= zn.r,
      },
      zone,
      mechs: seen,
      crates: crates.filter((c) => c.alive && visibleItem(c.pos)).map((c) => ({ id: c.id, pos: v3(c.pos) })),
      pickups: pickups.filter((p) => visibleItem(p.pos)).map((p) => ({ id: p.id, kind: p.kind, pos: v3(p.pos) })),
      cubes: cubes.filter((c) => visibleItem(c.pos)).map((c) => ({ id: c.id, pos: v3(c.pos) })),
      drops: drops.map((d) => ({ id: d.id, pos: v3(d.pos), radius: R.supply.radius, lands_in: round(Math.max(0, d.landT - t)), holder: d.holder })),
      projectiles: projectiles.filter((p) => near(p.pos, 130)).map((p) => ({ kind: p.kind, pos: v3(p.pos), vel: v3(p.vel) })),
      sounds: heard,
      events: m.events,
      offer: m.offer ? { choices: m.offer.choices, expires_in: round(m.offer.expires - t) } : null,
    }
    m.events = []
    m.lastObsT = t
    return obs
  }

  // ---- main loop ----
  while (t < maxTime && aliveCount > 1) {
    if (tick % DECIDE_EVERY === 0) {
      for (const m of mechs) {
        if (!m.alive) continue
        const obs = observe(m)
        if (!m.bot) { m.action = { move: [0, 0] }; continue }
        const t0 = performance.now()
        try {
          const action = m.bot.act(obs)
          m.action = action && typeof action === "object" ? action : { move: [0, 0] }
        } catch (e) {
          m.errors++
          if (options.log && m.errors <= 3) console.error(`agent ${m.agent} slot ${m.id}`, e)
          m.action = { move: [0, 0] }
        }
        const ms = performance.now() - t0
        if (ms > 1000 && options.log) console.error(`slow act: slot ${m.id} ${m.agent} t${t.toFixed(1)} ${ms.toFixed(0)}ms ${m.action?._dbg ?? ""}`)
        if (options.trace?.includes(m.id) && (tick % 20 === 0 || (t >= (options as any).traceFrom && t < (options as any).traceFrom + 4))) console.log(`  [${m.id} ${m.agent}] t${t.toFixed(0)} pos ${m.pos.map((v) => v.toFixed(0)).join(",")} hp${m.hp.toFixed(0)} e${m.energy.toFixed(0)} cubes${m.cubes} ${String(m.action?._dbg ?? m.action?.debug?.label ?? "")} ms${ms.toFixed(1)} mv${JSON.stringify(m.action?.move)} j${m.action?.jump ? 1 : 0}`)
        m.actMs += ms; m.acts++; m.actMax = Math.max(m.actMax, ms)
      }
    }
    for (const m of mechs) if (m.alive) stepMech(m)
    for (const n of npcs) if (n.alive) stepNpc(n)
    stepProjectiles()
    stepWorld()
    tick++
    t = tick * DT
  }
  const survivors = mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
  survivors.forEach((m, i) => { m.place = i + 1 })
  return {
    seed, variant, duration: round(t),
    mechs: mechs.map((m) => ({
      slot: m.id, agent: m.agent, place: m.place, kills: m.kills, npcKills: m.npcKills, crates: m.crates, dmgDealt: Math.round(m.dmgDealt), dmgTaken: Math.round(m.dmgTaken),
      zoneDmg: Math.round(m.zoneDmg), cubes: m.cubes, cubesTaken: m.cubesTaken, upgrades: m.upgrades.length, supply: m.supply, deathT: round(m.deathT), deathCause: m.deathCause,
      errors: m.errors, actMs: round(m.acts ? m.actMs / m.acts : 0, 1000), actMax: round(m.actMax), outsideSeconds: round(m.timeInZoneOut),
    })),
  }
}

const wallCache = new WeakMap<GameMap, Float32Array>()
/** Chamfer distance to the nearest building or wall cell, ignoring slopes. */
function wallClearance(map: GameMap): Float32Array {
  const cached = wallCache.get(map)
  if (cached) return cached
  const nx = map.nx, ny = map.ny, d = new Float32Array(nx * ny)
  for (let k = 0; k < d.length; k++) d[k] = map.blocked[k] === 1 ? 0 : 1e6
  const a = 1, b = Math.SQRT2
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i
    let v = d[k]
    if (v === 0) continue
    if (i > 0) v = Math.min(v, d[k - 1] + a)
    if (j > 0) { v = Math.min(v, d[k - nx] + a); if (i > 0) v = Math.min(v, d[k - nx - 1] + b); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b) }
    d[k] = v
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i
    let v = d[k]
    if (v === 0) continue
    if (i < nx - 1) v = Math.min(v, d[k + 1] + a)
    if (j < ny - 1) { v = Math.min(v, d[k + nx] + a); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b); if (i > 0) v = Math.min(v, d[k + nx - 1] + b) }
    d[k] = v
  }
  wallCache.set(map, d)
  return d
}
