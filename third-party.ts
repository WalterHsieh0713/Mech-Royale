import type { GameMap } from "./map.ts"
import { routeTiming } from "./strategy.ts"
import type { Point, Zone } from "./strategy.ts"

type Rival = {
  id: number; pos: [number, number, number]; aim?: [number, number]
  hp: number; maxhp: number; damagedAt: number
}
type Cue = { kind: string; dist?: string; bearing?: number }
const shots = new Set(["gun", "laser", "lightning", "mortar"])
const angleError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

// Both rivals must still be visible. A stationary pair facing the same landmark
// cannot open a window simply because one is weak.
export function distractedTarget<T extends Rival>(pair: T[], position: Point, muzzleZ: number,
  range: number, time: number, ownShotAt: number, sounds: Cue[], map: GameMap,
  centerZ: (rival: T) => number, activeTarget?: number): T | null {
  if (pair.length !== 2 || pair[0].id === pair[1].id) return null
  let best: T | null = null
  for (const [index, victim] of pair.entries()) {
    const shooter = pair[1 - index]
    if (!shooter.aim || !Number.isFinite(shooter.aim[0]) || !Number.isFinite(shooter.aim[1])) continue
    if (shooter.hp <= 0 || victim.hp <= 0 || victim.hp > victim.maxhp * 0.55) continue
    if (activeTarget !== undefined && activeTarget !== victim.id) continue
    const [vx, vy] = victim.pos, [sx, sy] = shooter.pos
    const distance = Math.hypot(vx - position[0], vy - position[1])
    const separation = Math.hypot(vx - sx, vy - sy)
    if (distance < 18 || distance > Math.min(130, range * 0.9) || separation < 5 || separation > 120) continue
    if (angleError(shooter.aim[0], Math.atan2(vy - sy, vx - sx)) > Math.min(0.28, 0.08 + 3 / separation)) continue
    const eye = centerZ(shooter) + 2
    if (angleError(shooter.aim[1], Math.atan2(centerZ(victim) - eye, separation)) > 0.28) continue
    if (!map.los(sx, sy, eye, vx, vy, centerZ(victim)) || !map.los(...position, muzzleZ, vx, vy, centerZ(victim))) continue
    // Once a burst starts, only the original pair and a fixed short deadline
    // sustain it. Our own hits and sounds cannot extend it or start another.
    if (activeTarget === undefined) {
      const bearing = Math.atan2(sy - position[1], sx - position[0])
      const audibleShot = sounds.some(cue => shots.has(cue.kind) && cue.dist !== "far" &&
        typeof cue.bearing === "number" && angleError(cue.bearing, bearing) < 0.18)
      if (time - ownShotAt < 2 || (time - victim.damagedAt > 0.85 && !audibleShot)) continue
    }
    if (!best || victim.hp < best.hp) best = victim
  }
  return best
}

// Insist on a short, directly walkable retreat into solid cover from both rivals.
export function thirdPartyExit<T extends Rival>(map: GameMap, from: Point, rivals: T[], centerZ: (rival: T) => number,
  height: number, zone: Zone, time: number, speed: number, margin: number, preferred?: Point): Point | null {
  function usable(point: Point) {
    if (!map.walkLine(...from, ...point) || routeTiming(zone, from, [from, point], time, speed, 0, 1.25).minMargin < margin) return false
    const floor = map.floorAt(...point)
    return rivals.every(rival => [0.45, 0.92].every(fraction =>
      !map.los(rival.pos[0], rival.pos[1], centerZ(rival) + 2, ...point, floor + fraction * height, 0.5)))
  }
  if (preferred) return usable(preferred) ? preferred : null
  for (const distance of [6, 9, 12]) {
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8
      const point: Point = [from[0] + distance * Math.cos(angle), from[1] + distance * Math.sin(angle)]
      if (usable(point)) return point
    }
  }
  return null
}
