// stdin/stdout loop for mechfight/1. Answers only the newest observation.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GameMap } from "./map.ts"
import { makeBot } from "./bot.ts"

const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n")
const log = (...a: unknown[]) => console.error(...a)

let bot: { name: string; act(o: any): any } | null = null
let errors = 0
let buf = ""
let queued = false

function seeded(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
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
    bot = makeBot(msg, map, seeded(msg.seed ?? 1))
  } catch (e) {
    log("init failed", e)
  }
  send({ type: "ready", name: "survivor" })
}

function handle(lines: string[]) {
  let latest: any = null
  for (const line of lines) {
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === "hello") onHello(msg)
    else if (msg.type === "obs") latest = msg
    else if (msg.type === "end") process.exit(0)
  }
  if (!latest) return
  // A failed observation cannot safely reuse the last movement or boost request.
  let action: any = { move: [0, 0], boost: false }
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
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  if (queued) return
  queued = true
  setImmediate(flush)
})
function flush() {
  queued = false
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  handle(lines.filter((l) => l.trim()))
}
process.stdin.on("end", () => { buf += "\n"; flush() })
