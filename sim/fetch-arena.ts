// Downloads the public arena map used by the live game into ./arena/v2 (git-ignored).
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ARENA_DIR } from "./arena.ts"

const base = process.argv[2] ?? "https://play.joinbuilders.org/arena/v2/"
mkdirSync(join(ARENA_DIR, "v2"), { recursive: true })
for (const file of ["world.json", "terrain.i16"]) {
  const response = await fetch(base + file)
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  writeFileSync(join(ARENA_DIR, "v2", file), bytes)
  console.log(`${file}: ${bytes.length} bytes`)
}
