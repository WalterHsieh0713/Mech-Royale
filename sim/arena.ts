// Loads the live campus arena (arena/v2, fetched by `node sim/fetch-arena.ts`) or, when
// it is missing, generates a synthetic town of the same scale.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { GameMap } from "../map.ts"
import { seeded } from "./engine.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const ARENA_DIR = join(root, "arena")

export function loadArena(): { map: GameMap; source: string } {
  const worldPath = join(ARENA_DIR, "v2", "world.json"), terrainPath = join(ARENA_DIR, "v2", "terrain.i16")
  if (existsSync(worldPath) && existsSync(terrainPath)) {
    const world = JSON.parse(readFileSync(worldPath, "utf8"))
    const tb = readFileSync(terrainPath)
    const terrain = new Int16Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.length))
    return { map: tag(new GameMap(world, terrain), world, terrain), source: "campus" }
  }
  const { world, terrain } = syntheticTown(7)
  return { map: tag(new GameMap(world, terrain), world, terrain), source: "synthetic" }
}

function tag(map: GameMap, world: any, terrain: Int16Array) {
  Object.assign(map, { __world: world, __terrain: terrain })
  return map
}

/** Flat 900 m x 700 m ground with scattered buildings, walls and tree clumps. */
export function syntheticTown(seed: number) {
  const rng = seeded(seed)
  const nx = 901, ny = 701, minX = -450, minY = -350
  const terrain = new Int16Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) terrain[j * nx + i] = Math.round(300 * Math.sin(i / 90) * Math.cos(j / 70))
  const prisms: any[] = []
  for (let b = 0; b < 150; b++) {
    const cx = minX + 30 + rng() * (nx - 60), cy = minY + 30 + rng() * (ny - 60)
    const w = 6 + rng() * 26, h = 6 + rng() * 26, top = 8 + rng() * 25
    prisms.push({ kind: "building", base: -5, top, ring: [cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2], holes: [] })
  }
  const data: number[] = []
  for (let k = 0; k < 600; k++) {
    const x = minX + rng() * nx, y = minY + rng() * ny
    data.push(x, y, 0, 14, 3 + rng() * 3, 3)
  }
  const world = {
    terrain: { nx, ny, minX, minY, scale: 0.01 },
    bounds: { minX: minX + 1, minY: minY + 1, maxX: minX + nx - 2, maxY: minY + ny - 2 },
    prisms,
    trees: { fields: ["x", "y", "z", "height", "crownR", "crownBase"], data },
  }
  return { world, terrain }
}
