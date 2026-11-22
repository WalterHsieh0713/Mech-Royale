import { randomBytes } from "node:crypto"
const sid = randomBytes(16).toString("hex")
const url = `wss://play.joinbuilders.org/play?token=&sid=${sid}&name=mr-probe`
const ws = new WebSocket(url)
const seen = new Map<string, number>()
ws.onopen = () => console.log("open")
ws.onclose = (e) => { console.log("close", e.code, e.reason); process.exit(0) }
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  const n = (seen.get(m.type) ?? 0) + 1; seen.set(m.type, n)
  if (n <= 2 && m.type !== "obs") console.log(m.type, JSON.stringify(m).slice(0, 1500))
  if (m.type === "obs" && n <= 1) console.log("obs", JSON.stringify(m).slice(0, 2500))
  if (m.type === "lobby" && !m.you?.ready) ws.send(JSON.stringify({ type: "ready", name: "mr-probe" }))
  if (m.type === "obs" && n > 30) { console.log([...seen]); ws.close() }
}
setTimeout(() => { console.log("timeout", [...seen]); ws.close() }, 150000)
