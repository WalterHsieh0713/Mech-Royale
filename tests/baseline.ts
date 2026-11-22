// Run from the repository with bun tests/baseline.ts or node tests/baseline.ts.
// Use --stdin with JSON containing "bot.ts" and "map.ts" if child processes are restricted.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { flatArena, hello, hiddenCrate, passingMech, seedRandom } from "./arena-fixtures.ts"

const revision = "0f3e549021181a103bddc1536b67210db611581f"
const original = mkdtempSync(join(tmpdir(), "mech-royale-baseline-"))
const paths: string[] = []
try {
  const provided: Record<string, string> | undefined = process.argv.includes("--stdin")
    ? JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""))
    : undefined
  for (const file of ["bot.ts", "map.ts"]) {
    const contents = provided ? provided[file] : execFileSync("git", ["show", `${revision}:${file}`])
    const path = join(original, file)
    writeFileSync(path, contents)
    paths.push(path)
  }
  const manifest = join(original, "package.json")
  writeFileSync(manifest, '{"type":"module"}')
  paths.push(manifest)

  const { makeBot } = await import(pathToFileURL(join(original, "bot.ts")).href)
  const { GameMap } = await import(pathToFileURL(join(original, "map.ts")).href)
  const { world, terrain } = flatArena()
  const map = new GameMap(world, terrain)

  // Zero fixes the original hide sampler on the bot's position for this reproduction.
  const hidden = makeBot(hello, map, () => 0).act(hiddenCrate())
  assert.match(hidden._dbg, /^hide /)
  assert.equal(hidden.fire[0], true)
  const opening = makeBot(hello, map, seedRandom(hello.seed)).act(passingMech())
  assert.match(opening._dbg, /^fight\*/)
  assert.equal(opening.fire[0], true)

  const replay = () => {
    const bot = makeBot(hello, map, seedRandom(hello.seed))
    return Array.from({ length: 20 }, (_, i) => bot.act({ ...passingMech(), t: 10 + i / 10, tick: 600 + i }))
  }
  const start = performance.now()
  const recorded = replay()
  const elapsedMs = performance.now() - start
  assert.deepEqual(replay(), recorded)

  console.log(JSON.stringify({
    revision, fixtureOnly: true, hiddenCrate: hidden, openingPassingMech: opening,
    deterministicFrames: recorded.length, singleReplayMs: Number(elapsedMs.toFixed(3)),
  }, null, 2))
} finally {
  for (const path of paths) unlinkSync(path)
  rmdirSync(original)
}
