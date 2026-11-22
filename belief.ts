import type { GameMap } from "./map.ts"

type Point = [x: number, y: number, z: number]
type Sighting = { id: number; pos: readonly number[]; vel?: readonly number[] }
type SoundObservation = { bearing?: number | null; kind?: string; dist?: string }

interface Track {
  pos: Point
  velocity: [number, number]
  seenAt: number
  visible: boolean
}

interface Hypothesis {
  pos: Point
  weight: number
}

interface ExposureSample {
  pos: Point
  influence: number
}

interface SoundCue {
  origin: Point
  angle: number
  category?: string
  heardAt: number
  strength: number
}

const TRACK_LIFETIME = 16
const SOUND_LIFETIME = 5
const UPDATE_INTERVAL = 0.6
const RISK_CELL_SIZE = 4
const CONTACT_RANGE = 90
const SOUND_INFLUENCE = 120
const MAX_TRACKS = 16
const MAX_SOUNDS = 8
const MAX_EXPOSURE_TESTS = 5
const SOLID_COVER_EXPOSURE = 0.06
const MOVE_SOUNDS = new Set(["step", "boost", "jet", "reload"])
const COMBAT_SOUNDS = new Set(["gun", "laser", "laser_charge", "lightning", "mortar"])

function pointOf(pos: readonly number[]): Point | null {
  if (![pos[0], pos[1], pos[2]].every(Number.isFinite)) return null
  return [pos[0], pos[1], pos[2]]
}

function angleError(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
}

function confidence(age: number, lifetime: number): number {
  return Math.max(0, 1 - age / lifetime) ** 2
}

/** Remembers only observable evidence. Scores are tactical costs, not calibrated probabilities. */
export class ContactBeliefs {
  private readonly map: GameMap
  private readonly tracks = new Map<number, Track>()
  private sounds: SoundCue[] = []
  private hypotheses: Hypothesis[] = []
  private activeSounds: SoundCue[] = []
  private time = -Infinity
  private snapshotTime = -Infinity
  private epoch = 0
  private observedSpeed = 0
  // Per-cell risk cache, invalidated by bumping the stamp (A* queries it very often).
  private riskValue = new Float32Array(0)
  private riskStamp = new Int32Array(0)
  private riskEpoch = 1

  constructor(map: GameMap) {
    this.map = map
  }

  get revision(): number {
    return this.epoch
  }

  update(
    t: number,
    listener: readonly number[],
    visible: readonly Sighting[],
    sounds: readonly SoundObservation[],
    eliminated: readonly number[] = [],
  ): void {
    if (!Number.isFinite(t)) return
    let changed = false
    if (t < this.time) {
      this.tracks.clear()
      this.sounds = []
      this.observedSpeed = 0
      changed = true
    }
    this.time = t

    const seenNow = new Set<number>()
    for (const sighting of visible) {
      const pos = pointOf(sighting.pos)
      if (!pos || !Number.isFinite(sighting.id)) continue
      const previous = this.tracks.get(sighting.id)
      const delta = previous ? t - previous.seenAt : 0
      let velocity: [number, number] = [0, 0]
      if (sighting.vel && Number.isFinite(sighting.vel[0]) && Number.isFinite(sighting.vel[1])) {
        velocity = [sighting.vel[0], sighting.vel[1]]
      } else if (previous && delta > 0) {
        velocity = [(pos[0] - previous.pos[0]) / delta, (pos[1] - previous.pos[1]) / delta]
      }
      this.observedSpeed = Math.max(this.observedSpeed, Math.hypot(...velocity))
      if (!previous?.visible) changed = true
      this.tracks.set(sighting.id, { pos, velocity, seenAt: t, visible: true })
      seenNow.add(sighting.id)
    }
    for (const [id, track] of this.tracks) {
      if (t - track.seenAt >= TRACK_LIFETIME) {
        this.tracks.delete(id)
        changed = true
      } else if (track.visible && !seenNow.has(id)) {
        track.visible = false
        changed = true
      }
    }
    for (const id of eliminated) {
      if (this.tracks.delete(id)) changed = true
    }
    if (this.tracks.size > MAX_TRACKS) {
      const sorted = [...this.tracks].sort((a, b) => b[1].seenAt - a[1].seenAt || a[0] - b[0])
      for (const [id] of sorted.slice(MAX_TRACKS)) this.tracks.delete(id)
      changed = true
    }

    const lastCount = this.sounds.length
    this.sounds = this.sounds.filter(cue => t - cue.heardAt < SOUND_LIFETIME)
    if (this.sounds.length !== lastCount) changed = true
    const origin = pointOf(listener)
    if (origin) {
      for (const sound of sounds) {
        if (this.recordSound(t, origin, sound)) changed = true
      }
    }
    const hasEvidence = this.tracks.size > 0 || this.sounds.length > 0
    if (changed || (hasEvidence && t - this.snapshotTime >= UPDATE_INTERVAL)) {
      this.refresh(t)
    }
  }

  private recordSound(t: number, origin: Point, sound: SoundObservation): boolean {
    const { bearing, kind, dist } = sound
    if (typeof bearing !== "number" || !Number.isFinite(bearing) || !kind) return false
    const combat = COMBAT_SOUNDS.has(kind)
    if (!combat && !MOVE_SOUNDS.has(kind)) return false

    // Preserve the distance category without assigning a distance to it. Also avoid
    // adding full anonymous risk when a visible contact already explains this angle.
    const angle = Math.atan2(Math.sin(bearing), Math.cos(bearing))
    const explained = [...this.tracks.values()].some(track => {
      if (!track.visible) return false
      const dx = track.pos[0] - origin[0], dy = track.pos[1] - origin[1]
      return Math.hypot(dx, dy) < CONTACT_RANGE && angleError(angle, Math.atan2(dy, dx)) < 0.3
    })
    const strength = (combat ? 0.52 : 0.39) * (explained ? 0.3 : 1)
    const cue: SoundCue = { origin, angle, category: dist, heardAt: t, strength }
    const sameSector = this.sounds.findIndex(old =>
      old.category === dist &&
      Math.hypot(old.origin[0] - origin[0], old.origin[1] - origin[1]) <= 12 &&
      angleError(old.angle, angle) <= 0.42,
    )
    if (sameSector >= 0) {
      const old = this.sounds[sameSector]
      const originalStrength = old.strength * confidence(t - old.heardAt, SOUND_LIFETIME)
      if (strength >= originalStrength) this.sounds[sameSector] = cue
      return false
    }
    this.sounds.push(cue)
    if (this.sounds.length > MAX_SOUNDS) {
      this.sounds.sort((a, b) =>
        b.strength * confidence(t - b.heardAt, SOUND_LIFETIME) -
        a.strength * confidence(t - a.heardAt, SOUND_LIFETIME),
      )
      this.sounds.length = MAX_SOUNDS
    }
    return this.sounds.includes(cue)
  }

  private refresh(t: number): void {
    this.snapshotTime = t
    this.hypotheses = [...this.tracks.values()].flatMap(track => this.spread(track, t))
    this.activeSounds = [...this.sounds]
    this.riskEpoch++
    this.epoch++
  }

  private spread(track: Track, t: number): Hypothesis[] {
    const age = Math.max(0, t - track.seenAt)
    if (age === 0 || track.visible) return [{ pos: track.pos, weight: 1 }]

    // Measured velocities set the scale of uncertainty, rather than acting as a
    // claimed simulator speed bound. Bound the planning work and spatial extent.
    const velocity = Math.hypot(...track.velocity)
    const speedScale = Math.max(velocity, this.observedSpeed * 0.55)
    const direction = velocity > 0.1 ? Math.atan2(track.velocity[1], track.velocity[0]) : 0
    const lead = this.advance(track.pos, direction, Math.min(30, velocity * Math.min(age, 1.7)))
    const width = Math.min(60, speedScale * age * 0.85)
    const total = confidence(age, TRACK_LIFETIME)
    const straightWeight = velocity > 0.1 ? Math.max(0.18, 0.55 - age * 0.1) : 0
    const stationaryWeight = velocity > 0.1 ? 0.24 : 0.4
    const directions = velocity > 0.1
      ? [-1.55, -0.65, 0.65, 1.55, Math.PI]
      : [0, Math.PI / 3, Math.PI * 2 / 3, Math.PI, -Math.PI * 2 / 3, -Math.PI / 3]
    const branchWeight = (1 - straightWeight - stationaryWeight) / directions.length
    const result: Hypothesis[] = []
    const add = (pos: Point, weight: number) => {
      if (weight <= 0) return
      const duplicate = result.find(h => Math.hypot(h.pos[0] - pos[0], h.pos[1] - pos[1]) < 3)
      if (duplicate) duplicate.weight += weight * total
      else result.push({ pos, weight: weight * total })
    }
    add(track.pos, stationaryWeight)
    add(lead, straightWeight)
    const leadDistance = Math.hypot(lead[0] - track.pos[0], lead[1] - track.pos[1])
    for (const angle of directions) {
      const pivot = velocity > 0.1 && Math.abs(angle) < 1 ? lead : track.pos
      const distance = pivot === lead ? Math.max(0, width - leadDistance) : width
      add(this.advance(pivot, direction + angle, distance), branchWeight)
    }
    return result
  }

  private advance(origin: Point, angle: number, distance: number): Point {
    let pos = origin
    const vx = Math.cos(angle), vy = Math.sin(angle)
    const clearance = Math.max(1, Math.min(2.8, this.map.clearAt(origin[0], origin[1]) - 0.1))
    for (let travelled = 0; travelled < distance;) {
      travelled = Math.min(distance, travelled + 4)
      const x = origin[0] + vx * travelled, y = origin[1] + vy * travelled
      if (!this.map.walkLine(pos[0], pos[1], x, y, clearance)) break
      pos = [x, y, this.map.floorAt(x, y)]
    }
    return pos
  }

  riskAt(x: number, y: number): number {
    if (!this.hypotheses.length && !this.activeSounds.length) return 0
    const coarseX = this.map.minX + Math.round((x - this.map.minX) / RISK_CELL_SIZE) * RISK_CELL_SIZE
    const coarseY = this.map.minY + Math.round((y - this.map.minY) / RISK_CELL_SIZE) * RISK_CELL_SIZE
    const fineCell = this.map.toCell(x, y)
    const coarseCell = this.map.toCell(coarseX, coarseY)
    // Use the finer cell near obstacles so adjacent lanes cannot share a sample
    // snapped to a wall or to its other side.
    const cell = this.map.clearAt(coarseX, coarseY) > RISK_CELL_SIZE ? coarseCell : fineCell
    if (this.riskStamp.length !== this.map.cnx * this.map.cny) {
      this.riskStamp = new Int32Array(this.map.cnx * this.map.cny)
      this.riskValue = new Float32Array(this.map.cnx * this.map.cny)
    }
    if (this.riskStamp[cell] === this.riskEpoch) return this.riskValue[cell]
    const [sampleX, sampleY] = this.map.cellXY(cell)
    const ground = this.map.floorAt(sampleX, sampleY)
    let score = 0
    const exposed: ExposureSample[] = []
    for (const h of this.hypotheses) {
      const [hx, hy] = h.pos
      const distance = Math.hypot(hx - sampleX, hy - sampleY)
      if (distance >= CONTACT_RANGE) continue
      const proximity = Math.max(0, 1 - distance / 35) * 0.5
      const influence = h.weight * (1 - distance / CONTACT_RANGE) ** 1.25
      score += h.weight * proximity + influence * SOLID_COVER_EXPOSURE
      // Accumulate proximity from every hypothesis. Raycast only the positions
      // that can contribute most, making a cold path query cheaper in crowds.
      let i = exposed.length
      while (i > 0 && influence > exposed[i - 1].influence) i--
      if (i >= MAX_EXPOSURE_TESTS) continue
      exposed.splice(i, 0, { pos: h.pos, influence })
      if (exposed.length > MAX_EXPOSURE_TESTS) exposed.pop()
    }
    for (const { pos: [hx, hy, hz], influence } of exposed) {
      const canSee = this.map.see(hx, hy, hz + 7, sampleX, sampleY, ground + 7)
      const exposure = canSee ? 1
        : this.map.los(hx, hy, hz + 7, sampleX, sampleY, ground + 7, 0.5) ? 0.42
        : SOLID_COVER_EXPOSURE
      score += influence * (exposure - SOLID_COVER_EXPOSURE)
    }
    let soundRisk = 0
    for (const cue of this.activeSounds) {
      const dx = sampleX - cue.origin[0], dy = sampleY - cue.origin[1]
      const distance = Math.hypot(dx, dy)
      if (distance >= SOUND_INFLUENCE) continue
      const age = this.snapshotTime - cue.heardAt
      const width = 0.6 + age * 0.13
      const angle = angleError(cue.angle, Math.atan2(dy, dx))
      const direction = distance < 4 ? 0.35 : Math.max(0, 1 - angle / width)
      // This is the radius within which the policy cares about a cue, not a
      // translation of the reported distance band into an estimated position.
      const relevance = 1 - distance / SOUND_INFLUENCE
      soundRisk = Math.max(soundRisk, cue.strength * confidence(age, SOUND_LIFETIME) * direction * relevance)
    }
    const result = 1 - Math.exp(-score - soundRisk)
    this.riskStamp[cell] = this.riskEpoch
    this.riskValue[cell] = result
    return result
  }

  /** The most credible remembered contact position, weighted toward nearby evidence. */
  strongest(x: number, y: number): { pos: Point; weight: number; age: number } | null {
    let best: Hypothesis | null = null, score = 0
    for (const h of this.hypotheses) {
      const value = h.weight / (1 + Math.hypot(h.pos[0] - x, h.pos[1] - y) / 80)
      if (value > score) { score = value; best = h }
    }
    if (!best) return null
    let age = Infinity
    for (const track of this.tracks.values()) {
      age = Math.min(age, Math.max(0, this.time - track.seenAt) + Math.hypot(track.pos[0] - best.pos[0], track.pos[1] - best.pos[1]) / 40)
    }
    return { pos: best.pos, weight: best.weight, age }
  }

  scanBearing(x: number, y: number): number | null {
    let best: number | null = null, weight = 0
    for (const h of this.hypotheses) {
      const dx = h.pos[0] - x, dy = h.pos[1] - y
      const distance = Math.hypot(dx, dy)
      const relevance = h.weight / (1 + distance / 35)
      if (distance > 1 && relevance > weight) {
        best = Math.atan2(dy, dx)
        weight = relevance
      }
    }
    for (const cue of this.activeSounds) {
      const dx = cue.origin[0] - x, dy = cue.origin[1] - y
      const distance = Math.hypot(dx, dy)
      const relevance = 0.75 * cue.strength * confidence(this.snapshotTime - cue.heardAt, SOUND_LIFETIME) /
        (1 + distance / 22)
      if (distance < 24 && relevance > weight) {
        best = cue.angle
        weight = relevance
      }
    }
    return best
  }
}
