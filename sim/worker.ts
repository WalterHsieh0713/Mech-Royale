// Child process: loads the arena once, then runs matches sent by tournament.ts.
import { agentRegistry } from "./agents.ts"
import { loadArena } from "./arena.ts"
import { runMatch } from "./engine.ts"

const { map } = loadArena()
const registry = await agentRegistry()

process.on("message", (job: any) => {
  if (job?.type === "stop") process.exit(0)
  try {
    const agents = job.lineup.map((name: string) => {
      const make = registry[name]
      if (!make) throw new Error(`unknown agent ${name}`)
      return { name, make }
    })
    const result = runMatch(map, agents, job.seed, job.variant, { maxTime: job.maxTime })
    process.send!({ id: job.id, result })
  } catch (error) {
    process.send!({ id: job.id, error: String((error as Error)?.stack ?? error) })
  }
})
process.send!({ ready: true, agents: Object.keys(registry) })
