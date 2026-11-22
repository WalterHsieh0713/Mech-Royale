// Agents the simulator can seat: every strategy profile of the current bot, plus the
// last hand-written bot before the planned rewrite (commit 0f3e549) as a reference.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { makeBot } from "../bot.ts"
import { PROFILES } from "../profile.ts"
import type { BotFactory } from "./engine.ts"
import { houseFactory } from "./house.ts"

const here = dirname(fileURLToPath(import.meta.url))
const LEGACY_REVISION = "0f3e549021181a103bddc1536b67210db611581f"

async function legacyFactory(): Promise<BotFactory | null> {
  const dir = join(here, ".cache", "legacy")
  try {
    if (!existsSync(join(dir, "bot.ts"))) {
      mkdirSync(dir, { recursive: true })
      for (const file of ["bot.ts", "map.ts"]) {
        writeFileSync(join(dir, file), execFileSync("git", ["show", `${LEGACY_REVISION}:${file}`], { cwd: join(here, "..") }))
      }
      writeFileSync(join(dir, "package.json"), '{"type":"module"}')
    }
    const legacy = await import(pathToFileURL(join(dir, "bot.ts")).href)
    const { GameMap: LegacyMap } = await import(pathToFileURL(join(dir, "map.ts")).href)
    let cached: { world: any; terrain: Int16Array; map: any } | null = null
    // The legacy bot needs its own map class. Build it once from the same world.
    return (hello, map: any, rng) => {
      if (!cached || cached.world !== map.__world) cached = { world: map.__world, terrain: map.__terrain, map: new LegacyMap(map.__world, map.__terrain) }
      return legacy.makeBot(hello, cached.map, rng)
    }
  } catch {
    return null
  }
}

export async function agentRegistry(): Promise<Record<string, BotFactory>> {
  const registry: Record<string, BotFactory> = {}
  for (const name of Object.keys(PROFILES)) registry[name] = (hello, map, rng) => makeBot(hello, map, rng, name)
  const legacy = await legacyFactory()
  if (legacy) registry.legacy = legacy
  // Practice-lobby stand-ins (sim/house.ts): use as --field house-easy,house-medium,...
  for (const skill of ["easy", "medium", "hard", "expert"] as const) registry[`house-${skill}`] = houseFactory(skill)
  return registry
}
