// Runs seeded matches in parallel and ranks strategies.
//
//   node sim/tournament.ts --mode mixed --agents survivor,scaler,edge --matches 60
//   node sim/tournament.ts --mode field --candidates hybrid,survivor --field all --matches 40
//
// mixed: every agent gets an equal share of the 16 seats in every match.
// field: each match seats one candidate among 15 opponents drawn from the field, the
//        situation a submitted bot actually faces. Candidates share seeds (paired runs).
import { fork } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { seeded } from "./engine.ts"
import type { MatchResult } from "./engine.ts"
import { MATCH, VARIANTS } from "./rules.ts"
import { PROFILES } from "../profile.ts"

const here = dirname(fileURLToPath(import.meta.url))
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "")
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true"
  args.set(key, value)
}
const allAgents = [...Object.keys(PROFILES), "legacy"]
const list = (value: string | undefined, fallback: string[]) => !value || value === "all" ? fallback : value.split(",")
const mode = args.get("mode") ?? "mixed"
const matches = Number(args.get("matches") ?? 32)
const variants = list(args.get("variant"), ["base"]).flatMap((v) => v === "every" ? Object.keys(VARIANTS) : [v])
const workers = Number(args.get("workers") ?? Math.max(1, Math.min(cpus().length - 2, 22)))
const seed0 = Number(args.get("seed") ?? 1)
const maxTime = args.has("maxTime") ? Number(args.get("maxTime")) : undefined
const out = args.get("out")
const seats = MATCH.mechs

type Job = { id: number; seed: number; variant: string; lineup: string[]; maxTime?: number; candidate?: string }
const jobs: Job[] = []
for (const variant of variants) {
  for (let k = 0; k < matches; k++) {
    const seed = seed0 + k
    const rng = seeded(seed * 104729 + variant.length)
    const shuffle = (a: string[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
    if (mode === "mixed") {
      const agents = list(args.get("agents"), allAgents)
      const lineup: string[] = []
      for (let i = 0; i < seats; i++) lineup.push(agents[(i + k) % agents.length])
      jobs.push({ id: jobs.length, seed, variant, lineup: shuffle(lineup), maxTime })
    } else {
      const field = list(args.get("field"), allAgents)
      const opponents = Array.from({ length: seats - 1 }, () => field[Math.floor(rng() * field.length)])
      const slot = Math.floor(rng() * seats)
      for (const candidate of list(args.get("candidates"), allAgents)) {
        const lineup = [...opponents]
        lineup.splice(slot, 0, candidate)
        jobs.push({ id: jobs.length, seed, variant, lineup, maxTime, candidate })
      }
    }
  }
}

const results: (MatchResult & { candidate?: string; slot?: number })[] = []
const started = Date.now()
await new Promise<void>((resolve, reject) => {
  let next = 0, done = 0
  const pool = Math.min(workers, jobs.length)
  for (let w = 0; w < pool; w++) {
    const child = fork(join(here, "worker.ts"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] })
    const feed = () => {
      if (next < jobs.length) child.send(jobs[next++])
      else child.send({ type: "stop" })
    }
    child.on("message", (msg: any) => {
      if (msg.ready) return feed()
      if (msg.error) { reject(new Error(msg.error)); return }
      const job = jobs[msg.id]
      results.push({ ...msg.result, candidate: job.candidate, slot: job.candidate ? job.lineup.indexOf(job.candidate) : undefined })
      done++
      if (done % Math.max(1, Math.floor(jobs.length / 10)) === 0) process.stderr.write(`  ${done}/${jobs.length} matches, ${((Date.now() - started) / 1000).toFixed(0)}s\n`)
      if (done === jobs.length) resolve()
      feed()
    })
    child.on("error", reject)
  }
})

type Row = { n: number; wins: number; place: number; place2: number; top4: number; kills: number; cubes: number; dmg: number; taken: number; zone: number; zoneDeaths: number; errors: number; ms: number; msMax: number; survive: number; upgrades: number; npc: number }
const table = new Map<string, Row>()
const row = (name: string) => table.get(name) ?? table.set(name, { n: 0, wins: 0, place: 0, place2: 0, top4: 0, kills: 0, cubes: 0, dmg: 0, taken: 0, zone: 0, zoneDeaths: 0, errors: 0, ms: 0, msMax: 0, survive: 0, upgrades: 0, npc: 0 }).get(name)!
for (const match of results) {
  const seated = mode === "mixed" ? match.mechs : match.mechs.filter((m) => m.slot === match.slot)
  for (const m of seated) {
    const r = row(m.agent)
    r.n++; r.wins += m.place === 1 ? 1 : 0; r.place += m.place; r.place2 += m.place * m.place; r.top4 += m.place <= 4 ? 1 : 0
    r.kills += m.kills; r.cubes += m.cubesTaken; r.dmg += m.dmgDealt; r.taken += m.dmgTaken; r.zone += m.zoneDmg
    r.zoneDeaths += m.deathCause === "zone" ? 1 : 0; r.errors += m.errors; r.ms += m.actMs; r.msMax = Math.max(r.msMax, m.actMax)
    r.survive += m.deathT < 0 ? match.duration : m.deathT; r.upgrades += m.upgrades; r.npc += m.npcKills
  }
}
const summary = [...table.entries()].map(([agent, r]) => {
  const mean = r.place / r.n
  const sd = Math.sqrt(Math.max(0, r.place2 / r.n - mean * mean))
  return {
    agent, n: r.n, winPct: +(100 * r.wins / r.n).toFixed(1), meanPlace: +mean.toFixed(2), placeCI95: +(1.96 * sd / Math.sqrt(r.n)).toFixed(2),
    top4Pct: +(100 * r.top4 / r.n).toFixed(1), kills: +(r.kills / r.n).toFixed(2), cubes: +(r.cubes / r.n).toFixed(1), upgrades: +(r.upgrades / r.n).toFixed(1),
    npcKills: +(r.npc / r.n).toFixed(1), dmgDealt: Math.round(r.dmg / r.n), dmgTaken: Math.round(r.taken / r.n), zoneDmg: Math.round(r.zone / r.n),
    zoneDeathPct: +(100 * r.zoneDeaths / r.n).toFixed(1), survivalS: Math.round(r.survive / r.n), errors: r.errors, actMs: +(r.ms / r.n).toFixed(2), actMaxMs: Math.round(r.msMax),
  }
}).sort((a, b) => a.meanPlace - b.meanPlace)

const seconds = (Date.now() - started) / 1000
console.log(`\nmode=${mode} variants=${variants.join(",")} matches=${results.length} time=${seconds.toFixed(0)}s`)
console.table(summary.map(({ actMaxMs, errors, ...rest }) => ({ ...rest, err: errors })))
if (out) writeFileSync(out, JSON.stringify({ mode, variants, matches: results.length, summary, results }, null, 1))
