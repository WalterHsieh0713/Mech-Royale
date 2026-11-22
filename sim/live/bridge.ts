// Plays our real bot (main.ts) in live matches at play.joinbuilders.org and logs placements.
//
//   node sim/live/bridge.ts --strategies anchor,survivor --matches 10 --name mr-a
//
// The live server speaks mechfight/1 over a websocket, so main.ts runs unchanged as a child
// process; only hello.map.dir is pointed at our local arena/ copy. One child per match.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const strategies = (args.get("strategies") ?? "survivor").split(",")
const total = Number(args.get("matches") ?? 4)
const name = args.get("name") ?? "mr-bot"
const out = args.get("out") ?? join(root, "sim/results/live.jsonl")
const sid = randomBytes(16).toString("hex")

let played = 0
let bot: ChildProcess | null = null
let match: any = null
let ws: WebSocket

function log(...a: unknown[]) { console.log(new Date().toISOString().slice(11, 19), name, ...a) }

function startBot(hello: any) {
  const strategy = strategies[played % strategies.length]
  bot?.kill()
  const child = spawn(process.execPath, [join(root, "main.ts")], { cwd: root, env: { ...process.env, MR_STRATEGY: strategy }, stdio: ["pipe", "pipe", "pipe"] })
  bot = child
  match = { strategy, seed: hello.seed, slot: hello.slot, duration: hello.config?.match?.duration_s, start: Date.now(), place: null, kills: 0, lastObs: null, late: 0, answered: 0, sentAt: 0 }
  let buf = ""
  child.stdout!.setEncoding("utf8")
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk
    const lines = buf.split("\n"); buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === "ready") continue // the lobby uses "ready" for queueing; the live server needs no reply to hello
      if (bot !== child) return
      const ms = Date.now() - match.sentAt
      match.answered++
      if (ms > 40) match.late++
      delete msg.debug
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
  })
  child.stderr!.setEncoding("utf8")
  child.stderr!.on("data", (d: string) => { if (bot === child) process.stderr.write(`[${name}:${strategy}] ${d}`) })
  child.stdin!.on("error", () => {})
  hello.map = { ...hello.map, dir: join(root, "arena") }
  child.stdin!.write(JSON.stringify(hello) + "\n")
  log(`match start slot=${hello.slot} strategy=${strategy}`)
}

function finish(results: any) {
  if (!match) return
  const rows = results?.mechs ?? []
  const me = rows.find((r: any) => r.id === match.slot || r.slot === match.slot)
  const place = match.place ?? me?.place ?? 1
  const record = {
    when: new Date().toISOString(), name, strategy: match.strategy, seed: match.seed, place, points: 16 - place,
    kills: match.endMsg?.kills ?? match.kills, cubes: match.lastObs?.self?.cubes ?? null, upgrades: match.lastObs?.self?.upgrades?.length ?? null,
    lastAlive: match.lastObs?.alive ?? null, lateAnswers: match.late, answers: match.answered,
    field: rows.map((r: any) => r.name ?? r.bot ?? null).filter(Boolean),
  }
  appendFileSync(out, JSON.stringify(record) + "\n")
  log(`match over place=${place} strategy=${match.strategy} kills=${match.kills} cubes=${record.cubes}`)
  bot?.kill(); bot = null; match = null
  played++
  if (played >= total) { log("done"); ws.close(1000); setTimeout(() => process.exit(0), 500) }
}

function connect() {
  ws = new WebSocket(`wss://play.joinbuilders.org/play?token=&sid=${sid}&name=${encodeURIComponent(name)}`)
  ws.onclose = (e) => {
    if (played >= total) return
    log("socket closed", e.code, e.reason, "- reconnecting")
    setTimeout(connect, e.code === 4029 ? 15000 : 3000)
  }
  ws.onerror = () => {}
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data))
    if (msg.type === "lobby") {
      if (!msg.you?.ready && played < total) ws.send(JSON.stringify({ type: "ready", name }))
    } else if (msg.type === "hello") {
      if (!match || match.seed !== msg.seed) startBot(msg)
    } else if (msg.type === "obs") {
      if (!match || !bot || match.place != null) return
      match.lastObs = msg
      for (const ev of msg.events ?? []) if (ev.type === "kill") match.kills++
      match.sentAt = Date.now()
      bot.stdin!.write(JSON.stringify(msg) + "\n")
    } else if (msg.type === "end") {
      if (match && match.place == null) { match.place = msg.place; match.endMsg = msg; log(`out: place=${msg.place}`) }
      bot?.kill()
    } else if (msg.type === "results") {
      finish(msg)
    }
  }
}

connect()
