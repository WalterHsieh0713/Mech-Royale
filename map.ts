// Static map model: floor heights, obstacles, clearance, line of sight and A* on a coarse grid.

export type World = any
type Point = [number, number]
type RiskAt = (x: number, y: number) => number
/** `drops` lists waypoints reached by walking off a ledge rather than along clear ground. */
export type RoutePlan = { points: Point[]; status: "reached" | "partial" | "unreachable"; drops?: Point[] }
type RouteRisk = { length: number; integral: number; peak: number }

const STEP_UP = 1.2
const MECH_H = 9
const WALK_CLEARANCE = 2.8
const SEGMENT_SAMPLE_SPACING = 0.7
const MAX_RISK = 100

function boundedRisk(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_RISK, value)) : MAX_RISK
}

function segmentRisk(ax: number, ay: number, bx: number, by: number, riskAt: RiskAt): RouteRisk {
  const length = Math.hypot(bx - ax, by - ay)
  const samples = Math.max(1, Math.ceil(length / SEGMENT_SAMPLE_SPACING))
  let previous = boundedRisk(riskAt(ax, ay))
  let integral = 0, peak = previous
  for (let i = 1; i <= samples; i++) {
    const f = i / samples
    const risk = boundedRisk(riskAt(ax + (bx - ax) * f, ay + (by - ay) * f))
    integral += (previous + risk) / 2
    peak = Math.max(peak, risk)
    previous = risk
  }
  return { length, integral: integral * length / samples, peak }
}

function noMoreRisk(candidate: RouteRisk, original: RouteRisk): boolean {
  const epsilon = 1e-6
  return candidate.integral <= original.integral + epsilon && candidate.peak <= original.peak + epsilon
}

export class GameMap {
  nx: number
  ny: number
  minX: number
  minY: number
  ground: Float32Array // terrain height at 1 m vertices
  floor: Float32Array // walkable floor height (ground or low deck)
  solidLo: Float32Array // union interval of solids covering the cell (for LOS)
  solidHi: Float32Array
  blocked: Uint8Array // 1 = obstacle for ground navigation
  clear: Float32Array // distance (m) to nearest obstacle
  canLo: Float32Array // canopy (tree crown) vertical interval per cell
  canHi: Float32Array
  // exposure grid (4 m): fraction of sight lines from eye height that reach 70 m
  es = 4
  enx = 0
  eny = 0
  expo: Float32Array = new Float32Array(0)
  // coarse nav grid
  cs = 2
  cnx: number
  cny: number
  cwalk: Uint8Array
  ccost: Float32Array

  constructor(world: World, terrain: Int16Array) {
    const t = world.terrain
    this.nx = t.nx
    this.ny = t.ny
    this.minX = t.minX
    this.minY = t.minY
    const N = this.nx * this.ny
    this.ground = new Float32Array(N)
    for (let i = 0; i < N; i++) this.ground[i] = terrain[i] * (t.scale ?? 0.01)
    this.floor = Float32Array.from(this.ground)
    this.solidLo = new Float32Array(N).fill(1e9)
    this.solidHi = new Float32Array(N).fill(-1e9)
    this.blocked = new Uint8Array(N)
    for (const p of world.prisms) this.rasterPrism(p)
    this.canLo = new Float32Array(N).fill(1e9)
    this.canHi = new Float32Array(N).fill(-1e9)
    const tf: string[] = world.trees?.fields ?? []
    const td: number[] = world.trees?.data ?? []
    const F = tf.length
    if (F) {
      const ix = tf.indexOf("crownX") >= 0 ? tf.indexOf("crownX") : tf.indexOf("x")
      const iy = tf.indexOf("crownY") >= 0 ? tf.indexOf("crownY") : tf.indexOf("y")
      const iz = tf.indexOf("z"), ih = tf.indexOf("height"), ir = tf.indexOf("crownR"), ib = tf.indexOf("crownBase")
      for (let q = 0; q + F <= td.length; q += F) {
        const cx = td[q + ix], cy = td[q + iy], z0 = td[q + iz], h = td[q + ih], r = td[q + ir], cb = td[q + ib]
        const lo = z0 + cb, hi = z0 + h
        for (let j = Math.floor(cy - r - this.minY); j <= Math.ceil(cy + r - this.minY); j++)
          for (let i = Math.floor(cx - r - this.minX); i <= Math.ceil(cx + r - this.minX); i++) {
            if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
            const x = this.minX + i, y = this.minY + j
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
            const k = j * this.nx + i
            if (lo < this.canLo[k]) this.canLo[k] = lo
            if (hi > this.canHi[k]) this.canHi[k] = hi
          }
      }
    }
    // steep terrain / ledges become obstacles
    const nx = this.nx, ny = this.ny
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i
        if (this.blocked[k]) continue
        const f = this.floor[k]
        if (Math.abs(f - this.floor[k + 1]) > STEP_UP || Math.abs(f - this.floor[k - 1]) > STEP_UP || Math.abs(f - this.floor[k + nx]) > STEP_UP || Math.abs(f - this.floor[k - nx]) > STEP_UP) this.blocked[k] = 2
      }
    // map edges (arena bounds) are walls
    const b = world.bounds
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = this.minX + i, y = this.minY + j
        if (x < b.minX + 1 || x > b.maxX - 1 || y < b.minY + 1 || y > b.maxY - 1) this.blocked[j * nx + i] = 1
      }
    this.clear = this.distanceTransform()
    this.cnx = Math.floor(nx / this.cs)
    this.cny = Math.floor(ny / this.cs)
    this.cwalk = new Uint8Array(this.cnx * this.cny)
    this.ccost = new Float32Array(this.cnx * this.cny)
    for (let j = 0; j < this.cny; j++)
      for (let i = 0; i < this.cnx; i++) {
        const c = this.clear[(j * this.cs) * nx + i * this.cs]
        const k = j * this.cnx + i
        this.cwalk[k] = c >= 3.0 ? 1 : 0
        this.ccost[k] = c >= 6 ? 1 : 1 + (6 - c) * 0.5
        if (this.cwalk[k]) {
          // discourage high ground (stadium stands, raised plazas) whose exits are cliffs
          const f0 = this.floor[(j * this.cs) * nx + i * this.cs]
          let mn = f0
          for (let dj = -12; dj <= 12; dj += 4)
            for (let di = -12; di <= 12; di += 4) {
              const ii = i * this.cs + di, jj = j * this.cs + dj
              if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue
              const f = this.floor[jj * nx + ii]
              if (f < mn) mn = f
            }
          if (f0 - mn > 6) this.ccost[k] += 3
        }
      }
    this.buildDrops()
    this.buildExposure()
  }

  /** One-way ledge exits: coarse cell -> landing cells on open ground at least 2.5 m below. */
  dropFrom = new Map<number, number[]>()
  private buildDrops() {
    const cs = this.cs
    for (let j = 1; j < this.cny - 1; j++)
      for (let i = 1; i < this.cnx - 1; i++) {
        const k = j * this.cnx + i
        if (!this.cwalk[k]) continue
        const x = this.minX + i * cs, y = this.minY + j * cs
        if (this.clearAt(x, y) > 7) continue
        const f0 = this.floorAt(x, y)
        let lands: number[] | null = null
        for (let d = 0; d < 8; d++) {
          const dx = Math.cos(d * Math.PI / 4), dy = Math.sin(d * Math.PI / 4)
          // Follow walkable steps (a rim is often a little higher than the stands behind it)
          // until the first step down that is too tall to walk: that is the ledge.
          let previous = f0
          for (let r = 1; r <= 12; r++) {
            const fk = this.idx(x + dx * r, y + dy * r)
            if (this.blocked[fk] === 1 || this.floor[fk] > previous + STEP_UP) break
            if (this.floor[fk] >= previous - STEP_UP) { previous = this.floor[fk]; continue }
            // Ground right below a cliff is too close to it to be a coarse cell; land on the
            // first open cell further out, clearly below the takeoff.
            for (let q = r + 1; q <= r + 9; q++) {
              const landing = this.toCell(x + dx * q, y + dy * q)
              const [lx, ly] = this.cellXY(landing)
              if (landing === k || !this.cwalk[landing]) continue
              if (this.floorAt(lx, ly) < f0 - 2.5 && this.floorAt(lx, ly) < previous - 2) (lands ??= []).push(landing)
              break
            }
            break
          }
        }
        if (lands) this.dropFrom.set(k, lands)
      }
  }

  /** Sight line (canopy attenuates: ~4 m of crown blocks). */
  see(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(L))
    let can = 0
    const stepL = L / n
    for (let s = 1; s < n; s++) {
      const f = s / n
      const x = ax + dx * f, y = ay + dy * f, z = az + dz * f
      const k = this.idx(x, y)
      if (z < this.ground[k] - 0.3) return false
      if (z >= this.solidLo[k] && z <= this.solidHi[k]) return false
      if (z >= this.canLo[k] && z <= this.canHi[k]) { can += stepL; if (can > 4) return false }
    }
    return true
  }

  private buildExposure() {
    const es = this.es
    this.enx = Math.floor(this.nx / es)
    this.eny = Math.floor(this.ny / es)
    this.expo = new Float32Array(this.enx * this.eny).fill(1)
    const R = 70, DIRS = 12
    const cs = new Float32Array(DIRS), sn = new Float32Array(DIRS)
    for (let d = 0; d < DIRS; d++) { cs[d] = Math.cos((d / DIRS) * Math.PI * 2); sn[d] = Math.sin((d / DIRS) * Math.PI * 2) }
    for (let j = 0; j < this.eny; j++)
      for (let i = 0; i < this.enx; i++) {
        const k1 = (j * es) * this.nx + i * es
        if (this.clear[k1] < 3) continue
        const x = this.minX + i * es, y = this.minY + j * es, z = this.floor[k1] + 7
        let tot = 0
        for (let d = 0; d < DIRS; d++) {
          let can = 0, r = 2
          for (; r <= R; r += 2) {
            const k = this.idx(x + cs[d] * r, y + sn[d] * r)
            const zz = z + 0.0
            if (zz < this.ground[k] || (zz >= this.solidLo[k] && zz <= this.solidHi[k])) break
            if (zz >= this.canLo[k] && zz <= this.canHi[k]) { can += 2; if (can > 4) break }
          }
          tot += Math.min(r, R) / R
        }
        this.expo[j * this.enx + i] = tot / DIRS
      }
  }
  costAt(x: number, y: number): number { return this.ccost[this.toCell(x, y)] }
  expoAt(x: number, y: number): number {
    const i = Math.round((x - this.minX) / this.es), j = Math.round((y - this.minY) / this.es)
    if (i < 0 || j < 0 || i >= this.enx || j >= this.eny) return 1
    return this.expo[j * this.enx + i]
  }

  private rasterPrism(p: any) {
    const r: number[] = p.ring
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i])
      y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1])
    }
    const holes: number[][] = p.holes ?? []
    const i0 = Math.max(0, Math.floor(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.ceil(x1 - this.minX))
    const j0 = Math.max(0, Math.floor(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      for (let i = i0; i <= i1; i++) {
        const x = this.minX + i
        if (!pip(r, x, y)) continue
        let inHole = false
        for (const h of holes) if (h.length >= 6 && pip(h, x, y)) { inHole = true; break }
        if (inHole) continue
        const k = j * this.nx + i
        if (p.base < this.solidLo[k]) this.solidLo[k] = p.base
        if (p.top > this.solidHi[k]) this.solidHi[k] = p.top
        const g = this.ground[k]
        if (p.base <= g + 0.5) {
          // solid from the ground up
          if (p.top - g <= STEP_UP) this.floor[k] = Math.max(this.floor[k], p.top)
          else this.blocked[k] = 1
        } else if (p.base - g >= MECH_H + 0.2) {
          // overhead: walk under
        } else if (p.top - g <= STEP_UP + 4 && p.kind === "bridge") {
          this.floor[k] = Math.max(this.floor[k], p.top)
        } else this.blocked[k] = 1
      }
    }
  }

  private distanceTransform(): Float32Array {
    // two-pass chamfer distance
    const nx = this.nx, ny = this.ny, N = nx * ny
    const d = new Float32Array(N)
    for (let k = 0; k < N; k++) d[k] = this.blocked[k] ? 0 : 1e6
    const a = 1, b = Math.SQRT2
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        let v = d[k]
        if (v === 0) continue
        if (i > 0) v = Math.min(v, d[k - 1] + a)
        if (j > 0) {
          v = Math.min(v, d[k - nx] + a)
          if (i > 0) v = Math.min(v, d[k - nx - 1] + b)
          if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b)
        }
        d[k] = v
      }
    for (let j = ny - 1; j >= 0; j--)
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i
        let v = d[k]
        if (v === 0) continue
        if (i < nx - 1) v = Math.min(v, d[k + 1] + a)
        if (j < ny - 1) {
          v = Math.min(v, d[k + nx] + a)
          if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b)
          if (i > 0) v = Math.min(v, d[k + nx - 1] + b)
        }
        d[k] = v
      }
    return d
  }

  idx(x: number, y: number): number {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }
  groundAt(x: number, y: number): number {
    const fx = x - this.minX, fy = y - this.minY
    let i = Math.floor(fx), j = Math.floor(fy)
    if (i < 0) i = 0; if (j < 0) j = 0
    if (i >= this.nx - 1) i = this.nx - 2; if (j >= this.ny - 1) j = this.ny - 2
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j))
    const k = j * this.nx + i, g = this.ground
    return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + this.nx] * (1 - u) + g[k + this.nx + 1] * u) * v
  }
  floorAt(x: number, y: number) { return this.floor[this.idx(x, y)] }
  clearAt(x: number, y: number) { return this.clear[this.idx(x, y)] }
  isBlocked(x: number, y: number) { return this.blocked[this.idx(x, y)] !== 0 }
  roofTop(x: number, y: number) { return this.solidHi[this.idx(x, y)] }

  /** True if the straight 3D segment a->b is not blocked by solids or terrain. */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, endSkip = 1.0): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(L / 0.8))
    const skip = L > 0 ? endSkip / L : 0
    for (let s = 1; s < n; s++) {
      const f = s / n
      if (f < skip || f > 1 - skip) continue
      const x = ax + dx * f, y = ay + dy * f, z = az + dz * f
      const k = this.idx(x, y)
      if (z < this.ground[k] - 0.3) return false
      if (z >= this.solidLo[k] && z <= this.solidHi[k]) return false
    }
    return true
  }

  /** Straight walk from a to b stays in cells with clearance >= c. */
  walkLine(ax: number, ay: number, bx: number, by: number, c = WALK_CLEARANCE): boolean {
    if (!this.inGrid(ax, ay) || !this.inGrid(bx, by)) return false
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / SEGMENT_SAMPLE_SPACING))
    for (let s = 0; s <= n; s++) {
      const f = s / n
      if (this.clear[this.idx(ax + (bx - ax) * f, ay + (by - ay) * f)] < c) return false
    }
    return true
  }

  private inGrid(x: number, y: number): boolean {
    return x >= this.minX && y >= this.minY && x <= this.minX + this.nx - 1 && y <= this.minY + this.ny - 1
  }

  /** Integrate the risk along a polyline, measured from the given start point. */
  routeRisk(sx: number, sy: number, points: readonly Point[], riskAt: RiskAt): RouteRisk {
    let x = sx, y = sy
    let length = 0, integral = 0, peak = boundedRisk(riskAt(sx, sy))
    for (const [px, py] of points) {
      const segment = segmentRisk(x, y, px, py, riskAt)
      length += segment.length
      integral += segment.integral
      peak = Math.max(peak, segment.peak)
      x = px
      y = py
    }
    return { length, integral, peak }
  }

  /** Check whether traveling directly to the final waypoint preserves the safety of the original route. */
  canShortcut(sx: number, sy: number, via: readonly Point[], riskAt?: RiskAt, clearance = WALK_CLEARANCE): boolean {
    const goal = via[via.length - 1]
    if (!goal || !this.walkLine(sx, sy, goal[0], goal[1], clearance)) return false
    if (!riskAt || via.length === 1) return true
    const direct = segmentRisk(sx, sy, goal[0], goal[1], riskAt)
    return noMoreRisk(direct, this.routeRisk(sx, sy, via, riskAt))
  }

  // ---------- coarse A* ----------
  private heap = new Int32Array(1 << 18)
  private hkeys = new Float32Array(1 << 18)
  private gScore = new Float32Array(0)
  private came = new Int32Array(0)
  private stamp = new Int32Array(0)
  private closed = new Int32Array(0)
  private viaDrop = new Int32Array(0)
  private curStamp = 0

  toCell(x: number, y: number): number {
    let i = Math.round((x - this.minX) / this.cs), j = Math.round((y - this.minY) / this.cs)
    i = Math.max(0, Math.min(this.cnx - 1, i)); j = Math.max(0, Math.min(this.cny - 1, j))
    return j * this.cnx + i
  }
  cellXY(c: number): [number, number] {
    const i = c % this.cnx, j = (c / this.cnx) | 0
    return [this.minX + i * this.cs, this.minY + j * this.cs]
  }
  nearestWalkable(c: number, maxR = 12, accept?: (cell: number) => boolean): number {
    if (this.cwalk[c] && (!accept || accept(c))) return c
    const ci = c % this.cnx, cj = (c / this.cnx) | 0
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = 1e9
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.cnx || j >= this.cny) continue
          const k = j * this.cnx + i
          if (!this.cwalk[k]) continue
          const d = di * di + dj * dj
          if (d < bd && (!accept || accept(k))) { bd = d; best = k }
        }
      if (best >= 0) return best
    }
    return -1
  }

  /** Compatibility API for callers that do not need to distinguish a partial route. */
  path(sx: number, sy: number, gx: number, gy: number, maxExpand = 60000, extraCost?: RiskAt): Point[] | null {
    const route = this.planPath(sx, sy, gx, gy, maxExpand, extraCost)
    return route.status === "unreachable" ? null : route.points
  }

  /** A* with bounded extra cost per meter of exposure and a checked route to the exact goal. */
  planPath(sx: number, sy: number, gx: number, gy: number, maxExpand = 60000, extraCost?: RiskAt): RoutePlan {
    const unreachable: RoutePlan = { points: [], status: "unreachable" }
    const N = this.cnx * this.cny
    if (!N || !this.inGrid(sx, sy) || !Number.isFinite(gx) || !Number.isFinite(gy)) return unreachable
    // A mech can stand where this conservative model sees too little clearance (a slope the
    // server's 1.5 m step allows, or a wall it was pushed against). Leave such a spot along
    // the most open short segment instead of declaring every goal unreachable.
    const tight = this.clearAt(sx, sy) < WALK_CLEARANCE
    if (tight && this.clearAt(sx, sy) < 0.5) return unreachable
    if (this.gScore.length !== N) {
      this.gScore = new Float32Array(N); this.came = new Int32Array(N); this.stamp = new Int32Array(N)
      this.closed = new Int32Array(N); this.viaDrop = new Int32Array(N)
    }
    const s = this.nearestWalkable(this.toCell(sx, sy), 12, (cell) => {
      const [x, y] = this.cellXY(cell)
      return this.walkLine(sx, sy, x, y, tight ? Math.min(1, this.clearAt(sx, sy) - 0.05) : WALK_CLEARANCE)
    })
    const goalCell = this.toCell(gx, gy)
    let g = this.inGrid(gx, gy) && this.clearAt(gx, gy) >= WALK_CLEARANCE
      ? this.nearestWalkable(goalCell, 12, (cell) => {
        const [x, y] = this.cellXY(cell)
        return this.walkLine(x, y, gx, gy)
      })
      : -1
    const exactGoalAttached = g >= 0
    if (!exactGoalAttached) g = this.nearestWalkable(goalCell)
    if (s < 0 || g < 0) return unreachable
    this.curStamp++
    const st = this.curStamp
    const cnx = this.cnx
    const gi = g % cnx, gj = (g / cnx) | 0
    let hn = 0
    const heap = this.heap, hk = this.hkeys
    const push = (node: number, key: number) => {
      let i = hn++
      while (i > 0) {
        const p = (i - 1) >> 1
        if (hk[p] <= key) break
        heap[i] = heap[p]; hk[i] = hk[p]; i = p
      }
      heap[i] = node; hk[i] = key
    }
    const pop = (): number => {
      const top = heap[0]
      hn--
      const node = heap[hn], key = hk[hn]
      let i = 0
      while (true) {
        let c = 2 * i + 1
        if (c >= hn) break
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++
        if (hk[c] >= key) break
        heap[i] = heap[c]; hk[i] = hk[c]; i = c
      }
      heap[i] = node; hk[i] = key
      return top
    }
    const H = (k: number) => {
      const di = Math.abs(k % cnx - gi), dj = Math.abs(((k / cnx) | 0) - gj)
      return (Math.max(di, dj) + 0.4142 * Math.min(di, dj)) * 1.0
    }
    this.stamp[s] = st; this.gScore[s] = 0; this.came[s] = -1
    push(s, H(s))
    let expanded = 0, found = false
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    let bestNode = s, bestH = H(s)
    while (hn > 0 && hn < heap.length - 16) {
      const cur = pop()
      if (this.closed[cur] === st) continue
      if (cur === g) { found = true; break }
      const hc = H(cur)
      if (hc < bestH) { bestH = hc; bestNode = cur }
      if (++expanded > maxExpand) break
      this.closed[cur] = st
      const ci = cur % cnx, cj = (cur / cnx) | 0
      const gc = this.gScore[cur]
      const x = this.minX + ci * this.cs, y = this.minY + cj * this.cs
      for (let d = 0; d < 8; d++) {
        const ni = ci + DI[d], nj = cj + DJ[d]
        if (ni < 0 || nj < 0 || ni >= cnx || nj >= this.cny) continue
        const nk = nj * cnx + ni
        if (!this.cwalk[nk] || this.closed[nk] === st) continue
        if (d >= 4 && (!this.cwalk[cj * cnx + ni] || !this.cwalk[nj * cnx + ci])) continue
        const nx = this.minX + ni * this.cs, ny = this.minY + nj * this.cs
        // A coarse edge can pass between fine cells with less clearance than either endpoint.
        if ((this.ccost[nk] > 1 || this.ccost[cur] > 1) && !this.walkLine(x, y, nx, ny)) continue
        let step = (d >= 4 ? 1.4142 : 1) * (this.ccost[nk] + this.ccost[cur]) * 0.5
        // One midpoint sample per 2 m edge; the smoothing pass below still compares exact
        // integrals, so a shortcut cannot cross risk the search avoided.
        if (extraCost) step += boundedRisk(extraCost((x + nx) / 2, (y + ny) / 2)) * (d >= 4 ? 1.4142 : 1)
        const ng = gc + step
        if (this.stamp[nk] === st && ng >= this.gScore[nk]) continue
        this.stamp[nk] = st; this.gScore[nk] = ng; this.came[nk] = cur; this.viaDrop[nk] = 0
        push(nk, ng + H(nk))
      }
      const drops = this.dropFrom.get(cur)
      if (drops) for (const nk of drops) {
        if (this.closed[nk] === st) continue
        const [nx, ny] = this.cellXY(nk)
        const length = Math.hypot(nx - x, ny - y) / this.cs
        const ng = gc + length * 1.5 + 2 + (extraCost ? boundedRisk(extraCost(nx, ny)) * length : 0)
        if (this.stamp[nk] === st && ng >= this.gScore[nk]) continue
        this.stamp[nk] = st; this.gScore[nk] = ng; this.came[nk] = cur; this.viaDrop[nk] = st
        push(nk, ng + H(nk))
      }
    }
    const end = found ? g : bestNode
    const cells: number[] = []
    for (let c = end; c >= 0 && cells.length < N; c = this.came[c]) { cells.push(c); if (c === s) break }
    cells.reverse()
    const pts = cells.map((c) => this.cellXY(c))
    const landing = cells.map((c, index) => index > 0 && this.viaDrop[c] === st && this.came[c] === cells[index - 1])
    const reached = found && exactGoalAttached
    if (reached) { pts.push([gx, gy]); landing.push(false) }
    // Use the original route's cumulative risk to check shortcuts, including their riskiest individual sample.
    const out: Point[] = []
    const drops: Point[] = []
    let ax = sx, ay = sy
    let i = 0
    const startClearance = tight ? Math.min(1, this.clearAt(sx, sy) - 0.05) : WALK_CLEARANCE
    while (i < pts.length) {
      // A ledge hop goes straight from its takeoff cell to its landing; nothing shortcuts it.
      if (landing[i]) {
        out.push(pts[i]); drops.push(pts[i])
        ax = pts[i][0]; ay = pts[i][1]
        i++
        continue
      }
      // From a tight start, only the hop to the first cell may use the reduced clearance.
      const fromStart = tight && ax === sx && ay === sy
      let last = fromStart ? i : Math.min(pts.length - 1, i + 40)
      for (let k = i + 1; k <= last; k++) if (landing[k]) { last = k - 1; break }
      let j = last
      if (extraCost && !fromStart) {
        const original: RouteRisk[] = []
        let px = ax, py = ay
        for (let k = i; k <= last; k++) {
          const [bx, by] = pts[k]
          const segment = segmentRisk(px, py, bx, by, extraCost)
          const previous = original[original.length - 1]
          original.push(previous ? {
            length: previous.length + segment.length,
            integral: previous.integral + segment.integral,
            peak: Math.max(previous.peak, segment.peak),
          } : segment)
          px = bx
          py = by
        }
        while (j > i) {
          const [bx, by] = pts[j]
          if (this.walkLine(ax, ay, bx, by) &&
            noMoreRisk(segmentRisk(ax, ay, bx, by, extraCost), original[j - i])) break
          j--
        }
      } else {
        while (j > i && !this.walkLine(ax, ay, pts[j][0], pts[j][1])) j--
      }
      if (!this.walkLine(ax, ay, pts[j][0], pts[j][1], fromStart ? startClearance : WALK_CLEARANCE)) {
        return out.length ? { points: out, status: "partial", drops } : unreachable
      }
      if (pts[j][0] !== ax || pts[j][1] !== ay) out.push(pts[j])
      ax = pts[j][0]; ay = pts[j][1]
      i = j + 1
    }
    if (reached) return { points: out, status: "reached", drops }
    return out.length ? { points: out, status: "partial", drops } : unreachable
  }
}

function pip(r: number[], x: number, y: number): boolean {
  let inside = false
  const n = r.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
