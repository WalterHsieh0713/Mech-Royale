// Replays recorded observations through a real bot process at the server's 10 Hz pace and
// reports answer latency, the way check/check.py measures it.
//   node sim/replay-timing.ts sim/results/obs-slot0.jsonl [command...]
// Pin it to one core on Windows: start /affinity 1 /wait node sim/replay-timing.ts ...
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const [file, ...cmd] = process.argv.slice(2)
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
const command = cmd.length ? cmd : [process.execPath, "main.ts"]
const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, MR_STRATEGY: process.env.MR_STRATEGY ?? "survivor" } })
let buf = ""
const waiting = new Map<number, number>()
const latency: number[] = []
let ready: () => void
const readyP = new Promise<void>((r) => (ready = r))
child.stdout.setEncoding("utf8")
child.stdout.on("data", (d: string) => {
  buf += d
  const parts = buf.split("\n"); buf = parts.pop() ?? ""
  for (const p of parts) {
    if (!p.trim()) continue
    let m: any
    try { m = JSON.parse(p) } catch {
      // node --trace-gc output: report pauses over 3 ms
      const pause = /MB, (?:pooled: [\d.]+ MB, )?([\d.]+) \//.exec(p)
      if (pause && Number(pause[1]) > 3) console.log(`gc ${Number(pause[1]).toFixed(1)} ms: ${p.split(":")[2]?.trim().split(" ")[0] ?? ""}`)
      continue
    }
    if (m.type === "ready") { ready(); continue }
    const sent = waiting.get(m.tick)
    if (sent !== undefined) {
      const ms = performance.now() - sent
      latency.push(ms); waiting.delete(m.tick)
      if (ms > 30) console.log(`slow tick ${m.tick}: ${ms.toFixed(1)} ms ${m.debug?.label ?? ""}`)
    }
  }
})
const t0 = performance.now()
child.stdin.write(lines[0] + "\n")
await readyP
console.log(`hello answered in ${(performance.now() - t0).toFixed(0)} ms`)
const obs = lines.slice(1)
for (let i = 0; i < obs.length; i++) {
  const tick = JSON.parse(obs[i]).tick
  waiting.set(tick, performance.now())
  child.stdin.write(obs[i] + "\n")
  await new Promise((r) => setTimeout(r, 100))
}
await new Promise((r) => setTimeout(r, 300))
child.kill()
const missed = obs.length - latency.filter((x) => x <= 50).length
latency.sort((a, b) => a - b)
const q = (p: number) => latency[Math.floor(p * (latency.length - 1))]?.toFixed(1)
console.log(`obs=${obs.length} answered=${latency.length} p50=${q(0.5)} p99=${q(0.99)} max=${q(1)} over30=${latency.filter((x) => x > 30).length} missed50=${missed}`)
