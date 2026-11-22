// stdin/stdout loop for mechfight/1 with an answer-time guarantee.
//
// The bot thinks on a worker thread (brain.ts). This thread only relays: it hands the
// worker the newest observation whenever the worker is free (merging events and sounds of
// observations it skipped) and answers every observation within ANSWER_MS. If the worker
// has not finished by then, it repeats the last move and aim; the worker's late result is
// still used to update that fallback. A late answer is worse than a slightly stale one: the
// server skips it and the mech coasts without firing for a second.
import { Worker } from "node:worker_threads"

const ANSWER_MS = Number(process.env.MR_ANSWER_MS ?? 33)
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n")
const log = (...a: unknown[]) => console.error(...a)

const worker = new Worker(new URL("./brain.ts", import.meta.url))
let ready = false
let busy = true // until the worker answers hello
let pending: any = null // newest observation the worker has not seen yet
let current: { tick: number; answered: boolean; timer: ReturnType<typeof setTimeout> } | null = null
let last: any = { move: [0, 0], boost: false } // the most recent action the worker produced
let fallbacks = 0

function answer(action: any, tick: number) {
  if (!current || current.tick !== tick || current.answered) return
  current.answered = true
  clearTimeout(current.timer)
  send({ ...action, tick })
}

function fallback(tick: number) {
  if (!current || current.tick !== tick || current.answered) return
  fallbacks++
  if (fallbacks <= 5 || fallbacks % 50 === 0) log(`fallback answer for tick ${tick} (${fallbacks} so far)`)
  // Keep moving, aiming and firing as last decided; one-shot requests are not repeated.
  const { move, aim, boost, fire, jump } = last
  answer({ move: move ?? [0, 0], ...(aim ? { aim } : {}), boost: !!boost, ...(fire !== undefined ? { fire } : {}), ...(jump ? { jump } : {}) }, tick)
}

function dispatch() {
  if (busy || !pending || !ready) return
  busy = true
  worker.postMessage(pending)
  pending = null
}

worker.on("message", (msg: any) => {
  if (msg.type === "ready") {
    ready = true
    busy = false
    send(msg)
    dispatch()
    return
  }
  busy = false
  const { tick, ...action } = msg
  last = action
  answer(action, tick)
  dispatch()
})
worker.on("error", (e) => log("worker failed", e))

function onObs(msg: any) {
  if (current && !current.answered) fallback(current.tick)
  current = { tick: msg.tick, answered: false, timer: setTimeout(() => fallback(msg.tick), ANSWER_MS) }
  if (pending) {
    // Events and sounds are per-observation deltas. Carry those of skipped observations
    // into the one the worker sees so damage, kills and footsteps are not lost.
    msg.events = [...(pending.events ?? []), ...(msg.events ?? [])]
    msg.sounds = [...(pending.sounds ?? []), ...(msg.sounds ?? [])].slice(-24)
  }
  pending = msg
  dispatch()
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === "hello") {
      ready = false; busy = true; pending = null; current = null; last = { move: [0, 0], boost: false }
      worker.postMessage(msg)
    } else if (msg.type === "obs") onObs(msg)
    else if (msg.type === "end") process.exit(0)
  }
})
process.stdin.on("end", () => process.exit(0))
