// Per-variant breakdown of a tournament results file: node sim/report.ts sim/results/x.json
import { readFileSync } from "node:fs"

const file = process.argv[2]
if (!file) throw new Error("usage: node sim/report.ts <results.json>")
const data = JSON.parse(readFileSync(file, "utf8"))
const byVariant = new Map<string, Map<string, { n: number; wins: number; place: number; top4: number; cubes: number }>>()
for (const match of data.results) {
  const table = byVariant.get(match.variant) ?? byVariant.set(match.variant, new Map()).get(match.variant)!
  const seated = data.mode === "mixed" ? match.mechs : match.mechs.filter((m: any) => m.slot === match.slot)
  for (const m of seated) {
    const row = table.get(m.agent) ?? table.set(m.agent, { n: 0, wins: 0, place: 0, top4: 0, cubes: 0 }).get(m.agent)!
    row.n++; row.wins += m.place === 1 ? 1 : 0; row.place += m.place; row.top4 += m.place <= 4 ? 1 : 0; row.cubes += m.cubesTaken
  }
}
for (const [variant, table] of byVariant) {
  console.log(`\n${variant}`)
  console.table([...table.entries()].map(([agent, r]) => ({
    agent, n: r.n, winPct: +(100 * r.wins / r.n).toFixed(1), meanPlace: +(r.place / r.n).toFixed(2), top4Pct: +(100 * r.top4 / r.n).toFixed(1), cubes: +(r.cubes / r.n).toFixed(1),
  })).sort((a, b) => a.meanPlace - b.meanPlace))
}
