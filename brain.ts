// The bot's thinking, run on a worker thread by main.ts. Receives hello and one observation
// at a time from main.ts (which merges skipped ones) and posts back ready and actions.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parentPort } from "node:worker_threads"
import { GameMap } from "./map.ts"
import { makeBot } from "./bot.ts"

const send = (o: unknown) => parentPort!.postMessage(o)
const log = (...a: unknown[]) => console.error(...a)

const TIMING = process.env.MR_TIMING === "1"
// With MR_TIMING=1, slow answers are logged with the time spent in each map query.
const spent = new Map<string, number>()
if (TIMING) {
  const { PerformanceObserver } = await import("node:perf_hooks")
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.duration > 3) log(`gc ${e.duration.toFixed(1)} ms`)
  }).observe({ entryTypes: ["gc"] })
  for (const method of ["planPath", "see", "los", "walkLine", "routeRisk", "canShortcut", "nearestWalkable", "expoAt"]) {
    const orig = (GameMap.prototype as any)[method]
    let depth = 0
    ;(GameMap.prototype as any)[method] = function (...a: any[]) {
      if (depth) return orig.apply(this, a)
      depth++
      const t0 = performance.now()
      try { return orig.apply(this, a) } finally { depth--; spent.set(method, (spent.get(method) ?? 0) + performance.now() - t0) }
    }
  }
}
let bot: { name: string; act(o: any): any } | null = null
let errors = 0

function seeded(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

// The first real observations ran 30+ ms on a cold JIT. Drive throwaway bots through a few
// seconds of synthetic play from different spots so act()'s planning code is compiled
// before the match starts. Bounded to a few seconds of the 20 s hello budget.
function warmBot(hello: any, map: GameMap) {
  const start = performance.now()
  const stats = hello.config?.mech ?? {}
  const gun = hello.config?.weapons?.gun ?? { damage: 45, cooldown: 0.24, speed: 252, range: 230, spread_deg: 0.6, mag: 12, reload: 2.4 }
  const spots: [number, number][] = [[20, -140], [-150, 60], [120, 120], [-60, -60], [200, -20]]
  for (const [sx, sy] of spots) {
    if (performance.now() - start > 4000) break
    try {
      const warm = makeBot({ ...hello, practice: false }, map, seeded(7))
      for (let k = 0; k < 25; k++) {
        const t = k * 0.1
        warm.act({
          type: "obs", tick: k * 2, t, alive: 16,
          self: {
            id: hello.slot ?? 0, pos: [sx + k * 0.5, sy, map.groundAt(sx + k * 0.5, sy)], vel: [5, 0, 0], aim: [0, 0],
            hp: 1400, max_hp: 1400, energy: 100, max_energy: 100, grounded: true, cubes: 0, upgrades: [],
            weapons: [{ kind: "gun", cooldown: 0, stats: gun, ammo: 12, reload: 0 }, null], in_zone: true, stats,
          },
          mechs: [], projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
          zone: { center: [40, -70], radius: 560, next_center: [90, -200], next_radius: 380, shrink_start: 30, shrink_end: 55, dps: 20 },
        })
      }
    } catch (e) {
      log("warmup failed", e)
      break
    }
  }
}

function onHello(msg: any) {
  bot = null
  errors = 0
  try {
    const dir = msg.map?.dir ?? "/arena"
    const world = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const tb = readFileSync(join(dir, "v2/terrain.i16"))
    const terrain = new Int16Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.length))
    const map = new GameMap(world, terrain)
    // warm up the JIT so the first observations are fast
    for (let i = 0; i < 6; i++) {
      map.path(-200 + i * 60, -100, 200 - i * 30, 150, 50000)
      for (let k = 0; k < 200; k++) map.see(-100 + k, 0, 5, 100, 50 + i, 5)
    }
    warmBot(msg, map)
    bot = makeBot(msg, map, seeded(msg.seed ?? 1))
  } catch (e) {
    log("init failed", e)
  }
  send({ type: "ready", name: "survivor" })
}

function step(latest: any) {
  // A failed observation cannot safely reuse the last movement or boost request.
  let action: any = { move: [0, 0], boost: false }
  spent.clear()
  const actT0 = performance.now()
  if (bot)
    try {
      const candidate = bot.act(latest)
      if (!candidate.move.every(Number.isFinite) || (candidate.aim && !candidate.aim.every(Number.isFinite))) {
        throw new Error("invalid action coordinates")
      }
      action = candidate
    } catch (e) {
      errors++
      if (errors <= 5 || errors % 100 === 0) log(`act failed tick ${latest.tick}:`, e)
    }
  const dbg = action._dbg
  delete action._dbg
  if (dbg) action.debug = { label: String(dbg).slice(0, 80) }
  action.tick = latest.tick
  send(action)
  if (TIMING) { const ms = performance.now() - actT0; if (ms > 20) log(`tick ${latest.tick} act ${ms.toFixed(1)} ms`, [...spent].filter(([, v]) => v > 1).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(" ")) }
}

parentPort!.on("message", (msg: any) => {
  if (msg.type === "hello") onHello(msg)
  else if (msg.type === "obs") { try { step(msg) } catch (e) { log("step crashed", e) } }
})
