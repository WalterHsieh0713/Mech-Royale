// One match in-process, for debugging: node sim/run-match.ts --seed 3 --agents survivor,scaler
import { agentRegistry } from "./agents.ts"
import { loadArena } from "./arena.ts"
import { runMatch } from "./engine.ts"
import { MATCH } from "./rules.ts"

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const t0 = performance.now()
const { map, source } = loadArena()
const registry = await agentRegistry()
const names = (args.get("agents") ?? "survivor").split(",")
const lineup = Array.from({ length: MATCH.mechs }, (_, i) => names[i % names.length])
console.log(`map ${source} loaded in ${(performance.now() - t0).toFixed(0)} ms`)
const t1 = performance.now()
const result = runMatch(map, lineup.map((name) => ({ name, make: registry[name] })), Number(args.get("seed") ?? 1), args.get("variant") ?? "base",
  { log: true, maxTime: args.has("maxTime") ? Number(args.get("maxTime")) : undefined, trace: args.get("trace")?.split(",").map(Number), traceFrom: Number(args.get("traceFrom") ?? 1e9) } as any)
console.log(`match ran ${result.duration}s of game time in ${((performance.now() - t1) / 1000).toFixed(1)} s`)
console.table(result.mechs.sort((a, b) => a.place - b.place))
