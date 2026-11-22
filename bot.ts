// Survival-first mech bot. Pure logic: makeBot(hello, map) -> { name, act(obs) }.
import { GameMap } from "./map.ts"
import type { RoutePlan } from "./map.ts"
import { ContactBeliefs } from "./belief.ts"
import { leaveBy, rotationEntries, rotationEntry, rotationMargin, rotationPressure, routeTiming, zoneMargin } from "./strategy.ts"
import type { Point, Zone } from "./strategy.ts"
import { distractedTarget, thirdPartyExit } from "./third-party.ts"

type V3 = [number, number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const d2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

const UPGRADE_PRI = [
  "plating", "armor", "nanites", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency",
  "gun_mag", "servos", "sensors", "gun_velocity", "capacitor", "reactor", "jets", "gyros", "lightning_range",
  "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce",
]
const WEAPON_PRI: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

type Track = { id: number; pos: V3; vel: V3; seen: number; hpSeen: number; damagedAt: number; hp: number; maxhp: number; cubes: number; weapons: string[]; charging: boolean; aim: [number, number]; visible: boolean }
type Objective = { kind: "loot" | "cube" | "drop" | "crate"; id: number; point: Point; value: number; pickup?: Point; dwell?: number }
type Intent = { mode: string; goal?: Point; fire: "players" | "crate" | "quiet"; boost: boolean; reason: string }

export function makeBot(hello: any, map: GameMap, rng: () => number = Math.random) {
  const cfg = hello.config
  const me_id = hello.slot
  const practice = hello.practice === true || process.env.MR_FORCE_SQUAD === "1" || (globalThis as any).MR_FORCE_SQUAD === true
  const aliveIncludesSelf = hello.alive_includes_self === true || process.env.MR_ALIVE_INCLUDES_SELF === "1"
  const beliefs = new ContactBeliefs(map)
  let t = 0
  const tracks = new Map<number, Track>()
  let lastDamageT = -99
  let ownShotAt = -Infinity
  let burst: { victim: number; other: number; exit: Point; until: number } | null = null
  let retreat: { point: Point; until: number } | null = null
  let nextAmbush = -Infinity
  const endBurst = (from: Point, speed: number) => {
    if (!burst) return
    retreat = { point: burst.exit, until: t + 1 + d2(from, burst.exit) / speed }
    nextAmbush = t + 8
    burst = null
  }
  let path: Point[] = []
  let pathGoal: Point | null = null
  let pathT = -99
  let pathRevision = -1
  let pathPurpose = ""
  let pathZone = ""
  let strafeDir = 1
  let strafeFlipT = 0
  let unstickUntil = -1
  let unstickDir: Point = [1, 0]
  let scanYaw = 0
  const takeFail = new Map<number, number>()
  const farmCooldowns = new Map<number, number>()
  let farming: { id: number; started: number } | null = null
  const attackers = new Map<number, number>()
  let cover: Point | null = null
  let coverT = -99
  let coverRevision = -1
  let coverZone = ""
  let coverContext = ""
  let peek: Point | null = null
  let peekT = -99
  let peekTarget: Track["pos"] | null = null
  let objective: Objective | null = null
  let objectiveT = -99
  let objectiveRevision = -1
  let objectiveZone = ""
  let walkingSpeed = 10 // Initial estimate until normal-speed movement is observed.
  let wasCruising = false
  let lastMoveT = -99
  let lastMovePos: Point | null = null
  const pickMem = new Map<number, { id: number; kind: string; pos: number[] }>()
  const posHist: [number, number, number, number][] = []
  const stuckEvents: number[] = []
  let unstickJet = false

  function inZoneSoon(zone: Zone, x: number, y: number, horizon: number, margin = 4) {
    return zoneMargin(zone, [x, y], t + horizon) >= margin
  }

  const threatAt = (x: number, y: number) => beliefs.riskAt(x, y)
  const navigationCost = (x: number, y: number) => 8 * threatAt(x, y) + 0.35 * map.expoAt(x, y)

  function betterRotationRoute(from: Point, zone: Zone, speed: number, candidate: Point[], alternative: Point[]) {
    const rank = (points: Point[]) => {
      const timing = routeTiming(zone, from, points, t, speed)
      const risk = map.routeRisk(...from, points, threatAt)
      const entry = rotationEntry(zone, from, points)
      const entryPressure = entry ? 12 * rotationPressure(zone, entry) : 0
      const score = timing.outsideSeconds * 25 + (timing.arrival - t) + risk.integral * 0.23 + risk.peak * 5 + entryPressure
      return { score, outside: timing.outsideSeconds }
    }
    const next = rank(candidate), previous = rank(alternative)
    if (Math.abs(next.outside - previous.outside) > 0.25) return next.outside < previous.outside
    return previous.score - next.score > 1e-6
  }

  function navigate(from: Point, goal: Point, zone: Zone, speed: number, emergency = false, compareFast = false): RoutePlan {
    const covered = map.planPath(...from, ...goal, emergency ? 14000 : 5500, navigationCost)
    if (!compareFast) return covered
    const fastest = map.planPath(...from, ...goal, emergency ? 14000 : 5500)
    if (covered.status !== "reached" && fastest.status !== "reached") {
      const remaining = (route: RoutePlan) => d2(route.points.at(-1) ?? from, goal)
      return remaining(fastest) < remaining(covered) ? fastest : covered
    }
    if (covered.status !== "reached") return fastest
    if (fastest.status !== "reached") return covered
    return betterRotationRoute(from, zone, speed, fastest.points, covered.points) ? fastest : covered
  }

  function followGoal(from: Point, goal: Point, purpose: string, zone: Zone, zoneKey: string, speed: number, emergency = false): Point {
    const changed = !pathGoal || d2(pathGoal, goal) > 0.75 || pathPurpose !== purpose || pathZone !== zoneKey
    const stale = t - pathT >= 2 || (pathRevision !== beliefs.revision && t - pathT >= 0.7)
    const earlyRotation = purpose === "tohide" && zoneMargin(zone, from, Math.max(t, zone.shrink_end)) < rotationMargin(zone)
    const compareFast = emergency || purpose === "zone" || earlyRotation
    if (changed || stale) {
      const route = navigate(from, goal, zone, speed, emergency, compareFast)
      path = route.status === "reached" || emergency ? route.points : []
      pathGoal = goal
      pathT = t
      pathRevision = beliefs.revision
      pathPurpose = purpose
      pathZone = zoneKey
    }
    const canSkipWaypoint = () => map.canShortcut(...from, path.slice(0, 2), navigationCost)
      && (!compareFast || !betterRotationRoute(from, zone, speed, path, path.slice(1)))
    while (path.length && d2(path[0], from) < (path.length === 1 ? 1.2 : 1.6)
      && (path.length === 1 || canSkipWaypoint())) path.shift()
    if (path.length >= 2 && canSkipWaypoint()) path.shift()
    const next = path[0]
    if (!next || !map.walkLine(...from, ...next)) return [0, 0]
    const length = d2(next, from)
    return [(next[0] - from[0]) / (length || 1), (next[1] - from[1]) / (length || 1)]
  }

  function escapeWall(x: number, y: number): Point {
    const initial = map.clearAt(x, y)
    let best: Point = [0, 0]
    let clearance = initial
    for (let i = 0; i < 12; i++) {
      const angle = TAU * i / 12
      const dx = Math.cos(angle), dy = Math.sin(angle)
      const middle = map.clearAt(x + dx * 1.5, y + dy * 1.5)
      const end = map.clearAt(x + dx * 3, y + dy * 3)
      if (middle >= initial && end > clearance) {
        best = [dx, dy]
        clearance = end
      }
    }
    return best
  }

  function mechCenterZ(tr: { pos: V3; cubes?: number }, kind = "mech") {
    if (kind === "npc") return tr.pos[2] + cfg.npc.height * 0.5
    if (kind === "crate") return tr.pos[2] + cfg.crates.height * 0.5
    return tr.pos[2] + cfg.mech.height * 0.5 * (1 + cfg.cubes.size_per_cube * (tr.cubes ?? 0))
  }

  function solveAim(self: any, tp: V3, tv: V3, speed: number, lat: number): { yaw: number; pitch: number; dist: number; tof: number; pt: V3 } {
    const mz = self.pos[2] + (self.stats?.muzzle_height ?? cfg.mech.muzzle_height)
    const ox = self.pos[0], oy = self.pos[1]
    let tof = 0
    let px = tp[0], py = tp[1], pz = tp[2]
    for (let i = 0; i < 4; i++) {
      const tt = tof + lat
      px = tp[0] + tv[0] * tt
      py = tp[1] + tv[1] * tt
      pz = tp[2] + (Math.abs(tv[2]) > 0.5 ? clamp(tv[2] * tt, -6, 6) : 0)
      const D = Math.hypot(px - ox, py - oy, pz - mz)
      tof = isFinite(speed) ? Math.max(0, D - 3) / speed : 0
    }
    const H = Math.hypot(px - ox, py - oy)
    return { yaw: Math.atan2(py - oy, px - ox), pitch: Math.atan2(pz - mz, H), dist: H, tof, pt: [px, py, pz] }
  }

  function mortarAim(self: any, tp: V3, tv: V3, ws: any): { yaw: number; pitch: number } | null {
    const v = ws.speed, g = ws.gravity
    const ox = self.pos[0], oy = self.pos[1], oz = self.pos[2] + cfg.mech.height + 0.5
    let tof = 1
    let res: { yaw: number; pitch: number } | null = null
    for (let it = 0; it < 3; it++) {
      const px = tp[0] + tv[0] * (tof + 0.05), py = tp[1] + tv[1] * (tof + 0.05), pz = tp[2] + 1
      const D = Math.hypot(px - ox, py - oy), H = pz - oz
      const disc = v ** 4 - g * (g * D * D + 2 * H * v * v)
      if (disc < 0) return null
      const sq = Math.sqrt(disc)
      const yaw = Math.atan2(py - oy, px - ox)
      // choose low arc if its path is clear, else high arc
      let chosen: number | null = null
      for (const th of [Math.atan((v * v - sq) / (g * D)), Math.atan((v * v + sq) / (g * D))]) {
        if (th > cfg.mech.max_pitch || th < cfg.mech.min_pitch) continue
        const vx = v * Math.cos(th), vz = v * Math.sin(th)
        const T = D / vx
        let ok = true
        for (let s = 1; s < 12; s++) {
          const tt = (T * s) / 12
          const hx = ox + Math.cos(yaw) * vx * tt, hy = oy + Math.sin(yaw) * vx * tt, hz = oz + vz * tt - 0.5 * g * tt * tt
          const k = map.idx(hx, hy)
          if (hz < map.ground[k] || (hz >= map.solidLo[k] && hz <= map.solidHi[k])) { ok = false; break }
        }
        if (ok) { chosen = th; tof = T; break }
      }
      if (chosen === null) return null
      res = { yaw, pitch: chosen }
    }
    return res
  }

  function chooseCover(from: Point, zone: Zone, speed: number, reserve: number, urgent: boolean, threats: Track[], height: number): Point | null {
    const center = zone.next_center
    const end = Math.max(t, zone.shrink_end)
    const rotating = urgent || zoneMargin(zone, from, end) < reserve
    const rotation = rotating ? rotationEntries(zone, from, reserve) : null
    const direct = rotation ? map.cellXY(map.toCell(...rotation.direct)) : null
    const points: Point[] = [from, center]
    if (cover) points.push(cover)
    if (rotation && direct) {
      points.push(direct, ...rotation.entries.map((sample) => map.cellXY(map.toCell(...sample))))
    } else {
      for (const radius of [10, 26, 52]) {
        for (let i = 0; i < 12; i++) {
          const angle = TAU * i / 12 + radius * 0.1
          const sample: Point = [from[0] + Math.cos(angle) * radius, from[1] + Math.sin(angle) * radius]
          points.push(map.cellXY(map.toCell(...sample)))
        }
      }
    }
    const seen = new Set<string>()
    const ranked = points.filter((point) => {
      const key = point.join(",")
      if (seen.has(key)) return false
      seen.add(key)
      return map.walkLine(...point, ...point, 3) && zoneMargin(zone, point, end) >= reserve
    }).map((point) => {
      let exposed = 0
      const floor = map.floorAt(...point)
      for (const threat of threats) {
        if (d2(threat.pos, point) > 180) continue
        const [ex, ey, ez] = threat.pos
        const solidSight = [0.5, 0.93].some((fraction) => map.los(ex, ey, ez + 8, ...point, floor + height * fraction, 0.5))
        if (solidSight) exposed += 1
      }
      let exits = 0
      for (const [dx, dy] of [[7, 0], [-7, 0], [0, 7], [0, -7]]) {
        const exit: Point = [point[0] + dx, point[1] + dy]
        if (map.walkLine(...point, ...exit) && inZoneSoon(zone, ...exit, 5, 0)) exits++
      }
      const distance = d2(point, from)
      const risk = threatAt(...point)
      // The old circle's wider approach may funnel other players into this entry.
      // Confirm local danger along the approach with observed contact estimates.
      let approach = 0
      if (rotating) {
        const dx = point[0] - from[0], dy = point[1] - from[1]
        for (const fraction of [0.3, 0.55, 0.8]) approach += threatAt(from[0] + fraction * dx, from[1] + fraction * dy) / 3
      }
      const score = 42 * exposed + 55 * risk + 22 * map.expoAt(...point)
        + (urgent ? 0.28 : 0.20) * distance - 2 * Math.min(2, exits)
        - (cover && d2(cover, point) < 1 ? 3 : 0)
      const shortlist = score + (rotating ? 16 * rotationPressure(zone, point) + 16 * approach : 0)
      return { point, score, shortlist }
    }).sort((a, b) => a.shortlist - b.shortlist)
    const finalists = ranked.slice(0, rotating ? 3 : 4)
    if (rotating) {
      // A quiet shortlist must not prune the two straightforward ways into the ring.
      for (const fallback of [direct, center]) {
        const entry = fallback && ranked.find(({ point }) => d2(point, fallback) < 1e-6)
        if (entry && !finalists.includes(entry)) finalists.push(entry)
      }
    }
    const assessed: { point: Point; score: number; outside: number }[] = []
    for (const { point, score } of finalists) {
      const route = navigate(from, point, zone, speed, urgent, rotating)
      if (route.status !== "reached") continue
      const timing = routeTiming(zone, from, route.points, t, speed)
      if (zoneMargin(zone, point, timing.arrival + 2) < reserve) continue
      const risk = map.routeRisk(...from, route.points, threatAt)
      const entry = rotating ? rotationEntry(zone, from, route.points) : null
      const entryPressure = entry ? 16 * rotationPressure(zone, entry) : 0
      const total = score + (timing.arrival - t) * 0.8 + 0.4 * risk.integral + risk.peak * 7
        + 30 * timing.outsideSeconds + entryPressure
      assessed.push({ point, score: total, outside: timing.outsideSeconds })
    }
    const shortestExposure = Math.min(...assessed.map(({ outside }) => outside))
    const feasible = rotating ? assessed.filter(({ outside }) => outside <= shortestExposure + 0.25) : assessed
    feasible.sort((a, b) => a.score - b.score)
    return feasible[0]?.point ?? null
  }

  function chooseFiringAngle(from: Point, zone: Zone, speed: number, margin: number, target: Track, range: number, muzzleHeight: number) {
    const positions: { point: Point; score: number }[] = []
    const targetHeight = mechCenterZ(target)
    const direction = Math.atan2(target.pos[1] - from[1], target.pos[0] - from[0])
    for (const distance of [8, 16, 28]) {
      for (const offset of [-1.8, -1.1, -0.45, 0.45, 1.1, 1.8]) {
        const angle = direction + offset
        const point: Point = [from[0] + distance * Math.cos(angle), from[1] + distance * Math.sin(angle)]
        if (d2(point, target.pos) >= range * 0.9 || d2(point, target.pos) < 12) continue
        if (!map.walkLine(...point, ...point) || !inZoneSoon(zone, ...point, distance / speed + 4, margin)) continue
        const muzzle = map.floorAt(...point) + muzzleHeight
        if (!map.los(...point, muzzle, target.pos[0], target.pos[1], targetHeight, 1.5)) continue
        positions.push({ point, score: distance * 0.35 + threatAt(...point) * 28 + map.expoAt(...point) * 10 })
      }
    }
    positions.sort((a, b) => a.score - b.score)
    for (const { point } of positions.slice(0, 3)) {
      const route = navigate(from, point, zone, speed)
      if (route.status === "reached" && routeTiming(zone, from, route.points, t, speed).minMargin >= margin) return point
    }
    return null
  }

  function pickUpgrade(offer: any, weapons: any[], radius: number, energy: number): number {
    let best = 0
    let bestScore = -Infinity
    offer.choices.forEach((choice: any, index: number) => {
      const priority = UPGRADE_PRI.indexOf(choice.id)
      let score = priority < 0 ? -100 : 24 - priority
      const prefix = String(choice.id).split("_")[0]
      if (["gun", "laser", "lightning", "mortar"].includes(prefix)) {
        score += weapons.some((w) => w?.kind === prefix) ? 3 : -10
        if (radius < 45 && prefix === "lightning") score += 4
        if (radius < 45 && prefix === "mortar") score -= 4
      }
      if (energy < 30 && ["reactor", "capacitor"].includes(choice.id)) score += 7
      if (score > bestScore) { best = index; bestScore = score }
    })
    return best
  }

  function act(obs: any): any {
    t = obs.t
    const self = obs.self
    const [x, y, z] = self.pos
    const act: any = {}
    const zone: Zone = obs.zone
    const hpFrac = self.hp / self.max_hp
    const position: Point = [x, y]
    const elapsed = t - lastMoveT
    if (wasCruising && lastMovePos && elapsed >= 0.025 && elapsed <= 0.75) {
      const observed = d2(position, lastMovePos) / elapsed
      if (observed >= 3 && observed <= 45) walkingSpeed += 0.15 * (observed - walkingSpeed)
    }
    const speed = walkingSpeed * 0.8
    const zoneKey = [zone.shrink_start, zone.shrink_end, ...zone.center, zone.radius, ...zone.next_center, zone.next_radius].join("/")

    // ---- memory ----
    for (const tr of tracks.values()) tr.visible = false
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      let tr = tracks.get(m.id)
      if (!tr) { tr = { id: m.id, hpSeen: -Infinity, damagedAt: -Infinity } as Track; tracks.set(m.id, tr) }
      if (Number.isFinite(m.hp)) {
        if (m.hp < tr.hp && t - tr.hpSeen < 0.6 && t - ownShotAt > 2) tr.damagedAt = t
        tr.hp = m.hp
        tr.hpSeen = t
      }
      tr.hp ??= 1400
      tr.maxhp = Number.isFinite(m.max_hp) && m.max_hp > 0 ? m.max_hp : tr.maxhp ?? 1400
      tr.pos = m.pos; tr.vel = m.vel ?? [0, 0, 0]; tr.seen = t
      tr.cubes = m.cubes ?? 0; tr.weapons = m.weapons ?? []; tr.charging = !!m.charging; tr.aim = m.aim; tr.visible = true
    }
    for (const [id, tr] of tracks) if (t - tr.seen > 20) tracks.delete(id)
    for (const p of obs.pickups) pickMem.set(p.id, { id: p.id, kind: p.kind, pos: p.pos })
    const visiblePickupIds = new Set(obs.pickups.map((p: any) => p.id))
    for (const [id, pm] of pickMem) {
      // Close enough to try collecting is a stronger signal than map visibility alone.
      if (d2(pm.pos, position) < cfg.loot.pickup_radius && !visiblePickupIds.has(id)
        && Math.abs(pm.pos[2] - z) < 3.8) pickMem.delete(id)
    }

    const visible = [...tracks.values()].filter((track) => track.visible)
    const damageCues = []
    for (const e of obs.events) {
      if (e.type === "damaged") {
        lastDamageT = t
        if (typeof e.by === "number" && tracks.has(e.by)) attackers.set(e.by, t)
        if (typeof e.bearing === "number" && !visible.some((track) => track.id === e.by)) {
          damageCues.push({ kind: "gun", bearing: e.bearing })
        }
      } else if (e.type === "take_failed") {
        takeFail.set(e.id, t)
        if (!visiblePickupIds.has(e.id)) pickMem.delete(e.id)
      }
    }
    for (const [id, tt] of attackers) if (t - tt > 4) attackers.delete(id)
    for (const [id, tt] of takeFail) if (t - tt > 4) takeFail.delete(id)
    for (const [id, tt] of farmCooldowns) if (t >= tt) farmCooldowns.delete(id)
    beliefs.update(t, self.pos, visible, [...obs.sounds, ...damageCues])

    // ---- weapons ----
    const W = self.weapons as any[]
    const slotOf = (k: string) => W.findIndex((w) => w && w.kind === k)
    const gunS = slotOf("gun"), laserS = slotOf("laser"), litS = slotOf("lightning"), mortS = slotOf("mortar")
    const extra = W[1]
    const chargeHeld = laserS >= 0 && (W[laserS].charge ?? 0) > 0
    if (obs.offer?.choices?.length) act.pick = pickUpgrade(obs.offer, W, zone.next_radius, self.energy)

    // ---- threats ----
    const mz = z + (self.stats?.muzzle_height ?? 7)
    // who can see / is aiming at me
    const watchers = visible.filter((e) => {
      const dd = d2(e.pos, position)
      const bearing = Math.atan2(y - e.pos[1], x - e.pos[0])
      return dd < 175 && (attackers.has(e.id) || (e.aim && Math.abs(wrap(e.aim[0] - bearing)) * dd < 8
        && map.see(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z + 6)))
    })
    const engaged = t - lastDamageT < 2.5 || watchers.length > 0
    // primary target: visible, LOS, prefer attackers, close, weak
    let target: Track | null = null
    let tScore = -1e9
    for (const e of visible) {
      const dd = d2(e.pos, [x, y])
      const los = map.los(x, y, mz, e.pos[0], e.pos[1], mechCenterZ(e), 1.5)
      let s = -dd - (e.hp / e.maxhp) * 60 + (los ? 80 : 0) + (attackers.has(e.id) ? 60 : 0)
      if (dd > 230) s -= 200
      if (s > tScore) { tScore = s; target = e }
    }
    const tDist = target ? d2(target.pos, [x, y]) : 1e9
    const tLos = target ? map.los(x, y, mz, target.pos[0], target.pos[1], mechCenterZ(target), 1.5) : false
    const firingRange = Math.max(0, ...W.map((weapon) => {
      if (!weapon || (weapon.kind === "lightning" && self.energy <= (weapon.stats.energy ?? 0) + 8)) return 0
      return weapon.stats.range ?? 0
    }))
    const canEngage = !!target && tLos && tDist <= firingRange
    const duel = aliveIncludesSelf && obs.alive === 2 && visible.length <= 1
    const cramped = visible.length === 1 && zone.next_radius <= 26 && zoneMargin(zone, position, t + 5) > 0 && tDist <= 55
    const favorable = !!target && (hpFrac > 0.48 || target.hp < self.hp * 0.65 || tDist < 23) && target.hp < self.hp * 1.6
    const fight = canEngage && (duel || cramped || (engaged && watchers.length <= 1 && favorable)
      || (practice && watchers.length <= 1 && hpFrac > 0.55 && tDist < 120))

    // ---- strategic intent and movement ----
    let move: Point = [0, 0]
    let jump = false
    let aim: Point | null = null
    const margin = rotationMargin(zone)
    const currentSlack = leaveBy(zone, position, t, margin) - t
    const nearestSafeDistance = Math.max(0, d2(position, zone.next_center) - zone.next_radius + margin)
    // Allow time for a detour and recovery before the shrinking edge reaches this position.
    const outside = zoneMargin(zone, position, t) < 0
    const rotationBudget = 4 + 1.5 * nearestSafeDistance / speed
    const urgent = outside || currentSlack <= rotationBudget
    const context = urgent ? "rotate" : engaged && !fight ? "escape" : "hold"
    const coverChanged = coverZone !== zoneKey || coverContext !== context
      || (coverRevision !== beliefs.revision && t - coverT >= 1.2)
    if ((context !== "hold" || !fight) && (coverChanged || (!cover && t - coverT >= 1.2) || (urgent && t - coverT >= 2))) {
      cover = chooseCover(position, zone, speed, margin, urgent, context === "escape" ? visible : [],
        cfg.mech.height * (1 + cfg.cubes.size_per_cube * (self.cubes ?? 0)))
      coverT = t
      coverRevision = beliefs.revision
      coverZone = zoneKey
      coverContext = context
    }
    const localRisk = threatAt(x, y)
    const reserve = litS >= 0 ? Math.max(30, (W[litS].stats.energy ?? 0) + 14) : 30
    let intent: Intent = { mode: "hide", fire: "quiet", boost: false, reason: "hold" }
    const gunForBurst = W[gunS]
    let thirdTarget: Track | null = null
    const ownHeight = cfg.mech.height * (1 + cfg.cubes.size_per_cube * (self.cubes ?? 0))
    const otherId = burst?.other
    const pairPresent = visible.length === 2 && (otherId === undefined || visible.some(rival => rival.id === otherId))
    const extraContact = pairPresent && [...tracks.values()].some(track => !track.visible && t - track.seen < 4 && d2(position, track.pos) < 110)
    if (pairPresent && !urgent && !fight && !engaged && !duel && !practice && !extraContact && t - lastDamageT > 4
      && t >= nextAmbush && currentSlack > rotationBudget + 4 && hpFrac >= 0.7 && self.energy >= 35 && !chargeHeld
      && t >= unstickUntil && gunForBurst?.ammo >= (burst ? 1 : 3) && !(gunForBurst.reload > 0)
      && (burst || !(gunForBurst.cooldown > 0.05))
      && (!burst || t < burst.until)) {
      thirdTarget = distractedTarget(visible, position, mz, gunForBurst.stats.range, t, ownShotAt,
        obs.sounds, map, mechCenterZ, burst?.victim)
      if (thirdTarget && t - thirdTarget.hpSeen < 0.6) {
        const exit = thirdPartyExit(map, position, visible, mechCenterZ, ownHeight, zone, t, speed, margin, burst?.exit)
        if (exit && !burst) {
          const other = visible[0].id === thirdTarget.id ? visible[1] : visible[0]
          burst = { victim: thirdTarget.id, other: other.id, until: t + 1.15, exit }
        } else if (!exit) thirdTarget = null
      } else thirdTarget = null
    }
    if (!thirdTarget) endBurst(position, speed)
    if (retreat && (urgent || duel || t >= retreat.until || d2(position, retreat.point) < 1.2
      || !thirdPartyExit(map, position, visible, mechCenterZ, ownHeight, zone, t, speed, margin, retreat.point))) retreat = null

    function withdrawTo(point: Point) {
      intent = { mode: "withdraw", fire: "quiet", boost: engaged && self.energy > reserve, reason: "break-sight" }
      const distance = d2(position, point)
      move = [(point[0] - x) / distance, (point[1] - y) / distance]
    }

    if (urgent) {
      intent = { mode: "zone", goal: cover ?? zone.next_center, fire: engaged && canEngage ? "players" : "quiet",
        boost: self.energy > (outside ? 14 : reserve), reason: outside ? "outside" : "deadline" }
    } else if (retreat) {
      withdrawTo(retreat.point)
    } else if (thirdTarget) {
      intent = { mode: "third-party", fire: "players", boost: false, reason: "short-burst" }
      target = thirdTarget
    } else if (engaged && !fight) {
      intent = { mode: "evade", goal: cover ?? undefined, fire: canEngage && (tDist < 32 || t - lastDamageT < 0.8) ? "players" : "quiet",
        boost: self.energy > 16, reason: "break-sight" }
    } else if (target && fight) {
      intent = { mode: "fight", fire: "players", boost: self.energy > reserve && !chargeHeld,
        reason: duel || cramped ? "endgame" : "defend" }
      const dd = tDist
      const ux = (target.pos[0] - x) / (dd || 1), uy = (target.pos[1] - y) / (dd || 1)
      if (t > strafeFlipT) { strafeDir = rng() < 0.5 ? -strafeDir : strafeDir; strafeFlipT = t + 0.45 + rng() * 0.9 }
      const hasLit = litS >= 0 && self.energy > 15
      const tw = target.weapons ?? []
      const enemyLit = tw.includes("lightning")
      const enemyMort = tw.includes("mortar")
      let prefMin = Math.min(40, firingRange * 0.5), prefMax = Math.min(110, firingRange * 0.83)
      let kite = false
      if (hasLit && !enemyMort && (!enemyLit || target.hp < self.hp)) { prefMin = 12; prefMax = 32 }
      else if (enemyLit) { prefMin = 58; prefMax = 120; kite = dd < 58 }
      let radial = 0
      if (dd < prefMin) radial = kite ? -1.6 : -0.7
      else if (dd > prefMax) radial = 0.8
      move = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial]
      const safeStep = ([dx, dy]: Point) => inZoneSoon(zone, x + dx * 5, y + dy * 5, 2, margin)
        && map.walkLine(x, y, x + dx * 4, y + dy * 4)
      if (!safeStep(move)) {
        strafeDir = -strafeDir
        strafeFlipT = t + 0.6
        const alternate: Point = [-uy * strafeDir + ux * radial, ux * strafeDir + uy * radial]
        move = safeStep(alternate) ? alternate : [0, 0]
      }
      if (!engaged && localRisk < 0.25 && map.expoAt(x, y) < 0.4 && dd <= prefMax) move = [0, 0]
    } else if (duel && target && firingRange > 0 && tDist <= firingRange + 24 && hpFrac > 0.3) {
      if (t - peekT >= 1.5 || (peekTarget && d2(peekTarget, target.pos) > 9)) {
        peek = chooseFiringAngle(position, zone, speed, margin, target, firingRange, mz - z)
        peekT = t
        peekTarget = target.pos
      }
      const goal = peek ?? cover
      if (goal && d2(goal, position) > 1.7) {
        intent = { mode: "tohide", goal, fire: "quiet", boost: false, reason: peek ? "firing-angle" : "cover" }
      }
    } else {
      const candidates: Objective[] = []
      const late = duel || zone.next_radius <= 45
      const weaponValue = (kind: string) => (WEAPON_PRI[kind] ?? -1)
        + (kind === "lightning" && late && self.energy > reserve ? 1.25 : 0)
        - (kind === "mortar" && late ? 1.5 : 0)
      const canSwap = !(extra?.kind === "laser" && chargeHeld)
      if (canSwap) for (const pickup of pickMem.values()) {
        if (takeFail.has(pickup.id) || slotOf(pickup.kind) >= 0) continue
        const improvement = weaponValue(pickup.kind) - (extra ? weaponValue(extra.kind) : -1)
        if (improvement <= 0 || Math.abs(pickup.pos[2] - z) >= 4) continue
        const point: Point = [pickup.pos[0], pickup.pos[1]]
        candidates.push({ kind: "loot", id: pickup.id, point, value: (extra ? 5 : 18) + improvement * 5 })
      }
      for (const cube of obs.cubes) {
        if (Math.abs(cube.pos[2] - z) >= 4) continue
        candidates.push({ kind: "cube", id: cube.id, point: [cube.pos[0], cube.pos[1]], value: late ? 9 : 18 })
      }
      for (const drop of obs.drops ?? []) {
        if ((drop.holder != null && drop.holder !== me_id) || drop.lands_in > 0.5) continue
        candidates.push({ kind: "drop", id: drop.id, point: [drop.pos[0], drop.pos[1]], value: late ? 12 : 22, dwell: 2 })
      }
      // The crate action is deliberate, limited to a short, quiet farm with a need for gear.
      const gun = gunS >= 0 ? W[gunS] : null
      if (!extra && gun && !late && hpFrac > 0.65 && (gun.ammo ?? 0) >= 3
        && t - lastDamageT > 5 && visible.length === 0 && localRisk < 0.15) {
        for (const crate of obs.crates) {
          if ((farmCooldowns.get(crate.id) ?? -Infinity) > t) continue
          if (d2(crate.pos, position) > Math.min(24, gun.stats.range) || Math.abs(crate.pos[2] - z) > 4) continue
          const cz = crate.pos[2] + cfg.crates.height * 0.5
          if (!map.los(x, y, mz, crate.pos[0], crate.pos[1], cz)) continue
          candidates.push({ kind: "crate", id: crate.id, point: position, pickup: [crate.pos[0], crate.pos[1]], value: 23, dwell: 3 })
        }
      }
      const previous = objective
      const stillAvailable = previous && candidates.some((candidate) => candidate.kind === previous.kind && candidate.id === previous.id)
      const reconsider = objectiveZone !== zoneKey || t - objectiveT >= 1.8
        || (objectiveRevision !== beliefs.revision && t - objectiveT >= 0.65) || (previous && !stillAvailable)
      if (reconsider) {
        objective = null
        objectiveT = t
        objectiveRevision = beliefs.revision
        objectiveZone = zoneKey
        let best = late ? 6 : 0
        const rank = (candidate: Objective) => candidate.value - d2(candidate.point, position) * 0.44
          - (candidate.kind === "crate" ? 6 : 0)
        for (const candidate of candidates.filter((item) => d2(item.point, position) <= (late ? 25 : 75))
          .sort((a, b) => rank(b) - rank(a)).slice(0, 3)) {
          if (!cover || rank(candidate) <= 0) continue
          const outward = navigate(position, candidate.point, zone, speed)
          if (outward.status !== "reached") continue
          const pickup = candidate.pickup ?? candidate.point
          const collect = candidate.pickup ? navigate(candidate.point, pickup, zone, speed) : null
          if (collect && collect.status !== "reached") continue
          const back = navigate(pickup, cover, zone, speed)
          if (back.status !== "reached") continue
          const outwardPoints = outward.points.length ? outward.points : [candidate.point]
          const points = [...outwardPoints, ...(collect?.points ?? []), ...back.points]
          const timing = routeTiming(zone, position, points, t, speed, outwardPoints.length - 1, candidate.dwell ?? 0.5)
          if (timing.minMargin < margin || zoneMargin(zone, cover, timing.arrival + 3) < margin) continue
          const risk = map.routeRisk(...position, points, threatAt)
          const stopRisk = Math.max(threatAt(...candidate.point), threatAt(...pickup))
          const score = candidate.value - (candidate.kind === "crate" ? 6 : 0) - (timing.arrival - t) * 1.8
            - 0.65 * risk.integral - 20 * Math.max(risk.peak, stopRisk) - 4 * stopRisk * (candidate.dwell ?? 1)
            + (previous?.id === candidate.id && previous.kind === candidate.kind ? 3 : 0)
          if (score > best) {
            best = score
            objective = candidate
          }
        }
      }
      if (objective && localRisk < 0.55 && currentSlack > 3) {
        intent = { mode: objective.kind === "crate" ? "farm" : "collect", goal: objective.point,
          fire: objective.kind === "crate" ? "crate" : "quiet", boost: false, reason: objective.kind }
        if (objective.kind === "loot" && d2(objective.point, position) <= cfg.loot.pickup_radius - 0.3
          && visiblePickupIds.has(objective.id) && canSwap) {
          act.take = objective.id
          if (extra) act.drop = 1
        }
      } else if (cover && d2(cover, position) > 1.7) {
        intent = { mode: "tohide", goal: cover, fire: "quiet", boost: false, reason: localRisk > 0.25 ? "avoid" : "cover" }
      }
    }
    if (intent.mode === "zone" || intent.mode === "evade" || intent.mode === "fight" || thirdTarget || retreat) {
      objective = null
      objectiveT = -99
    }
    if (intent.fire === "crate" && objective) {
      if (farming?.id !== objective.id) farming = { id: objective.id, started: t }
      if (t - farming.started >= 3) {
        farmCooldowns.set(objective.id, t + 12)
        farming = null
        objective = null
        objectiveT = -99
        intent = { mode: "hide", fire: "quiet", boost: false, reason: "farm-timeout" }
      }
    } else {
      if (farming) farmCooldowns.set(farming.id, t + 5)
      farming = null
    }
    if (intent.goal) {
      move = followGoal(position, intent.goal, intent.mode, zone, zoneKey, speed, intent.mode === "zone" || intent.mode === "evade")
      if (intent.mode === "tohide" && localRisk > 0.2 && currentSlack > 8) move = [move[0] * 0.8, move[1] * 0.8]
    }
    // ---- dodge incoming fire ----
    let dodge: Point | null = null
    let impactTime = Infinity
    let incomingFire = false
    const lateral = (direction: Point, length: number, mayReverse: boolean) => {
      const choices: Point[] = [direction]
      if (mayReverse) choices.push([-direction[0], -direction[1]])
      const currentMargin = zoneMargin(zone, position, t + 0.6)
      let best: Point | null = null
      let bestScore = -Infinity
      for (const [dx, dy] of choices) {
        const step: Point = [x + dx * length, y + dy * length]
        if (!map.walkLine(x, y, ...step)) continue
        const stepMargin = zoneMargin(zone, step, t + 0.6)
        if (stepMargin < Math.min(0, currentMargin) - 1) continue
        const score = dx * move[0] + dy * move[1] - 3 * threatAt(...step) + (urgent ? 0.2 * stepMargin : 0)
        if (score > bestScore) { best = [dx, dy]; bestScore = score }
      }
      return best
    }
    for (const p of obs.projectiles) {
      const rx = x - p.pos[0], ry = y - p.pos[1], rz = z + 4.5 - p.pos[2]
      const v2 = p.vel[0] ** 2 + p.vel[1] ** 2 + p.vel[2] ** 2
      if (v2 < 1) continue
      const tc = (rx * p.vel[0] + ry * p.vel[1] + rz * p.vel[2]) / v2
      if (tc < 0 || tc > 0.8 || tc >= impactTime) continue
      const cx = p.pos[0] + p.vel[0] * tc - x, cy = p.pos[1] + p.vel[1] * tc - y
      const height = p.pos[2] + p.vel[2] * tc - z
      const miss = Math.hypot(cx, cy)
      const thr = p.kind === "mortar" ? 9 : 3.5
      const vl = Math.hypot(p.vel[0], p.vel[1])
      if (vl > 0.01 && miss < thr && height >= -thr && height <= cfg.mech.height + thr) {
        incomingFire = true
        let px = -p.vel[1] / vl, py = p.vel[0] / vl
        if (px * -cx + py * -cy < 0) { px = -px; py = -py }
        const step = lateral([px, py], 4.5, miss < 1)
        if (step) { dodge = step; impactTime = tc }
      }
    }
    for (const e of watchers) {
      if (dodge || !e.charging || !e.aim) continue
      const dd = d2(e.pos, [x, y])
      const ang = Math.atan2(y - e.pos[1], x - e.pos[0])
      if (dd > 0.1 && Math.abs(wrap(e.aim[0] - ang)) * dd < 6
        && map.los(e.pos[0], e.pos[1], e.pos[2] + 7, x, y, z + 5)) {
        const ux = (x - e.pos[0]) / dd, uy = (y - e.pos[1]) / dd
        dodge = lateral([-uy * strafeDir, ux * strafeDir], 4.5, true)
      }
    }
    if ((incomingFire || dodge) && intent.mode === "third-party" && burst) {
      const exit = burst.exit
      endBurst(position, speed)
      if (dodge) intent.fire = "quiet"
      else withdrawTo(exit)
    }
    let boost = intent.boost
    if (dodge) {
      move = dodge
      boost = self.energy > 12
      intent.reason = "dodge"
      if (intent.fire === "crate") intent.fire = "quiet"
      if (act.take !== undefined) { delete act.take; delete act.drop }
    } else if (map.clearAt(x, y) < 2.8) {
      move = escapeWall(x, y)
      if (Math.hypot(...move) > 0) intent.reason = "clear-wall"
    }

    // ---- stuck handling ----
    const wantL = Math.hypot(move[0], move[1])
    posHist.push([t, x, y, wantL > 0.35 ? 1 : 0])
    while (posHist.length && t - posHist[0][0] > 1.6) posHist.shift()
    const old = posHist[0]
    const allWant = posHist.every((p) => p[3] === 1)
    if (!dodge && t < unstickUntil) {
      move = unstickDir
      if (unstickJet) { jump = self.grounded; boost = self.energy > 15 } else boost = false
    } else if (!dodge && allWant && t - old[0] > 1.4 && Math.hypot(x - old[1], y - old[2]) < 2.5) {
      stuckEvents.push(t)
      while (stuckEvents.length && t - stuckEvents[0] > 12) stuckEvents.shift()
      posHist.length = 0
      const ma = Math.atan2(move[1], move[0])
      if ((urgent || engaged) && self.energy > 35 && stuckEvents.length % 2 === 1) {
        // climb: jump and jet straight toward where we want to go
        unstickJet = true
        unstickDir = [Math.cos(ma), Math.sin(ma)]
        unstickUntil = t + 1.3
      } else {
        unstickJet = (urgent || engaged) && self.energy > 25
        const a = ma + (rng() < 0.5 ? 1 : -1) * (1.2 + rng() * 1.2)
        unstickDir = lateral([Math.cos(a), Math.sin(a)], 3, true) ?? escapeWall(x, y)
        unstickUntil = t + 0.9
      }
      path = []
      pathT = -99
    }

    const ml = Math.hypot(move[0], move[1])
    if (ml > 1) move = [move[0] / ml, move[1] / ml]

    // ---- aiming and firing ----
    const fire: [boolean, boolean] = [false, false]
    // A true input holds an existing laser charge. A false input releases it.
    if (chargeHeld) fire[laserS] = true
    let shootTarget: { pos: V3; vel: V3; cz: number; kind: "mech" | "crate"; r: number } | null = null
    if (target && intent.fire === "players") {
      shootTarget = { pos: target.pos, vel: target.vel, cz: mechCenterZ(target), kind: "mech",
        r: cfg.mech.radius * (1 + cfg.cubes.size_per_cube * target.cubes) }
    } else if (intent.fire === "crate") {
      const crate = obs.crates.find((c: any) => c.id === objective?.id)
      if (crate) shootTarget = { pos: crate.pos, vel: [0, 0, 0], cz: mechCenterZ(crate, "crate"), kind: "crate", r: cfg.crates.radius }
    }

    if (shootTarget) {
      const tp: V3 = [shootTarget.pos[0], shootTarget.pos[1], shootTarget.cz]
      const gunW = gunS >= 0 ? W[gunS] : null
      const gs = gunW ? gunW.stats.speed : 252
      const sol = solveAim(self, tp, shootTarget.vel, gs, 0.06)
      aim = [sol.yaw, sol.pitch]
      const yawErr = Math.abs(wrap(self.aim[0] - sol.yaw)) * sol.dist
      const pitErr = Math.abs(self.aim[1] - sol.pitch) * sol.dist
      const tol = shootTarget.r * 0.9 + 0.3
      const los = map.los(x, y, mz, sol.pt[0], sol.pt[1], sol.pt[2], 1.5)
      const onTarget = yawErr < tol && pitErr < 2.5
      if (gunW && los && onTarget && sol.dist < gunW.stats.range * 0.98 && (gunW.ammo ?? 1) > 0) fire[gunS] = true
      if (laserS >= 0 && shootTarget.kind === "mech" && intent.mode !== "third-party") {
        const lw = W[laserS]
        const ls = solveAim(self, tp, shootTarget.vel, Infinity, 0.05)
        const lerr = Math.abs(wrap(self.aim[0] - ls.yaw)) * ls.dist
        const pitchError = Math.abs(self.aim[1] - ls.pitch) * ls.dist
        const charging = (lw.charge ?? 0) > 0
        const full = (lw.charge ?? 0) >= lw.stats.charge * 0.97
        const losL = map.los(x, y, mz, ls.pt[0], ls.pt[1], ls.pt[2], 1.5)
        if (!charging) {
          if (lw.cooldown <= 0.05 && losL && ls.dist < lw.stats.range) fire[laserS] = true
        } else if (full && ls.dist < lw.stats.range && losL) {
          aim = [ls.yaw, ls.pitch]
          fire[laserS] = !(lerr < shootTarget.r * 0.8 && pitchError < 2.5)
        }
      }
      if (litS >= 0 && shootTarget.kind === "mech" && intent.mode !== "third-party") {
        const lw = W[litS]
        const yawE = Math.abs(wrap(self.aim[0] - sol.yaw))
        if (sol.dist < lw.stats.range * 0.95 && yawE < (lw.stats.cone_deg * Math.PI) / 360 * 0.8 && self.energy > lw.stats.energy + 8 && lw.cooldown <= 0.05 && los) fire[litS] = true
      }
      if (mortS >= 0 && shootTarget.kind === "mech" && intent.mode !== "third-party") {
        const mw = W[mortS]
        if (sol.dist > 25 && sol.dist < 220 && mw.cooldown <= 0.05) {
          const ma = mortarAim(self, [shootTarget.pos[0], shootTarget.pos[1], shootTarget.pos[2]], shootTarget.vel, mw.stats)
          if (ma && gunW && (gunW.ammo === 0 || (gunW.reload ?? 0) > 0)) {
            aim = [ma.yaw, ma.pitch]
            if (Math.abs(wrap(self.aim[0] - ma.yaw)) < 0.03 && Math.abs(self.aim[1] - ma.pitch) < 0.03) fire[mortS] = true
          }
        }
      }
    } else {
      const bearing = beliefs.scanBearing(x, y)
      if (bearing !== null) {
        aim = [bearing, 0]
      } else if (intent.mode === "hide") {
        scanYaw = wrap(scanYaw + Math.min(0.3, Math.max(0, elapsed) * 1.5))
        aim = [scanYaw, 0]
      } else if (Math.hypot(move[0], move[1]) > 0.2) {
        aim = [Math.atan2(move[1], move[0]), 0]
        scanYaw = aim[0]
      }
    }
    const gun = gunS >= 0 ? W[gunS] : null
    const safeReload = intent.mode === "hide" && ml < 0.1 && !dodge && localRisk < 0.1 && visible.length === 0
      && t - lastDamageT > 4 && currentSlack > 6
    if (gun && gun.ammo < gun.stats.mag * 0.5 && !(gun.reload > 0)
      && (safeReload || (gun.ammo === 0 && intent.fire === "players"))) act.reload = true

    act.move = [Math.round(move[0] * 1000) / 1000, Math.round(move[1] * 1000) / 1000]
    act.boost = boost && Math.hypot(move[0], move[1]) > 0.3
    if (jump) act.jump = true
    if (aim) act.aim = [Math.round(aim[0] * 10000) / 10000, Math.round(clamp(aim[1], cfg.mech.min_pitch, cfg.mech.max_pitch) * 10000) / 10000]
    act.fire = fire
    if (fire.some((trigger, slot) => trigger && slot !== laserS) || (chargeHeld && !fire[laserS])) ownShotAt = t
    lastMovePos = position
    lastMoveT = t
    wasCruising = self.grounded && !act.boost && !jump && Math.hypot(...move) > 0.95 && t >= unstickUntil
    const slack = Number.isFinite(currentSlack) ? Math.floor(currentSlack) : "+"
    act._dbg = `${intent.mode} ${intent.reason} risk${Math.round(localRisk * 100)} slack${slack} hp${Math.round(self.hp)} e${Math.round(self.energy)}`
    return act
  }

  return { name: "survivor", act }
}
