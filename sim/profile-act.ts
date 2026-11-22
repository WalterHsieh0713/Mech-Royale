// Finds slow bot decisions: node sim/profile-act.ts --seeds 1,2,3 --agents survivor,anchor
// Runs whole matches single-threaded and, for every act() over --slow ms, prints the time
// spent inside each GameMap method and the bot's debug label.
import { loadArena } from "./arena.ts"
import { agentRegistry } from "./agents.ts"
import { runMatch } from "./engine.ts"
import { MATCH } from "./rules.ts"
import { GameMap } from "../map.ts"

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const slow = Number(args.get("slow") ?? 20)
const seeds = (args.get("seeds") ?? "1").split(",").map(Number)
const names = (args.get("agents") ?? "survivor").split(",")
// --record file.jsonl saves slot 0's observations, to replay through main.ts (sim/replay-timing.ts).
const record = args.get("record")
const recorded: string[] = []

const spent = new Map<string, { ms: number; calls: number }>()
let depth = 0
for (const method of ["path", "planPath", "see", "los", "walkLine", "routeRisk", "canShortcut", "nearestWalkable", "expoAt"]) {
  const orig = (GameMap.prototype as any)[method]
  ;(GameMap.prototype as any)[method] = function (...a: any[]) {
    if (depth > 0) return orig.apply(this, a)
    depth++
    const t0 = performance.now()
    try { return orig.apply(this, a) } finally {
      depth--
      const s = spent.get(method) ?? { ms: 0, calls: 0 }
      s.ms += performance.now() - t0; s.calls++; spent.set(method, s)
    }
  }
}

const { map } = loadArena()
const registry = await agentRegistry()
const all: number[] = []
const slowRows: string[] = []
for (const seed of seeds) {
  const lineup = Array.from({ length: MATCH.mechs }, (_, i) => {
    const name = names[i % names.length]
    return {
      name, make: (hello: any, m: any, rng: any) => {
        if (record && hello.slot === 0 && seed === seeds[0]) recorded.push(JSON.stringify({ ...hello, type: "hello" }))
        const bot = registry[name](hello, m, rng)
        return {
          ...bot, act(obs: any) {
            if (record && hello.slot === 0 && seed === seeds[0]) recorded.push(JSON.stringify({ ...obs, type: "obs" }))
            spent.clear()
            const t0 = performance.now()
            const a = bot.act(obs)
            const ms = performance.now() - t0
            all.push(ms)
            if (ms > slow) slowRows.push(`seed${seed} ${name} t${obs.t?.toFixed?.(1)} ${ms.toFixed(1)}ms [${a?._dbg ?? ""}] ` +
              [...spent].sort((x, y) => y[1].ms - x[1].ms).slice(0, 4).map(([k, v]) => `${k}:${v.ms.toFixed(1)}/${v.calls}`).join(" "))
            return a
          },
        }
      },
    }
  })
  runMatch(map, lineup as any, seed, "base", {})
}
all.sort((a, b) => a - b)
const q = (p: number) => all[Math.floor(p * (all.length - 1))].toFixed(2)
console.log(`acts=${all.length} p50=${q(0.5)} p99=${q(0.99)} p999=${q(0.999)} max=${q(1)} over${slow}=${all.filter((x) => x > slow).length}`)
for (const r of slowRows.slice(0, 60)) console.log(r)
if (record) (await import("node:fs")).writeFileSync(record, recorded.join(String.fromCharCode(10)) + String.fromCharCode(10))
