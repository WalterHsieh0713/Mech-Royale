// A stand-in for the practice lobby's house squad: 15 bots that share vision, never target
// each other and hunt the one outsider, "one early, more as you thin them out, all of them
// late". The real house bots are private; this only copies the published description.
// Each house bot is our own bot (fragger knobs) whose view hides its squadmates and, when
// it is a hunter, adds the outsider's last position seen by any squadmate.
//
// UNCALIBRATED: first run (sim/results/practice-1) had every strategy dying almost first
// (~0.3 points vs 3.4-4.9 in real practice) and did not rank Josh's bot above survivor as
// practice did. These house bots are much stronger than the real ones; do not use for decisions.
import { makeBot } from "../bot.ts"
import type { BotFactory } from "./engine.ts"

export type Skill = "easy" | "medium" | "hard" | "expert"
// Chance a house bot holds fire on a given decision, a crude skill handicap.
const HOLD_FIRE: Record<Skill, number> = Object.fromEntries(
  (["easy", "medium", "hard", "expert"] as Skill[]).map((s, i) => [s, Number(process.env.MR_HOUSE_HOLD?.split(",")[i] ?? [0.85, 0.7, 0.5, 0.3][i])]),
) as Record<Skill, number>

// One squad per simulated match. Matches run one at a time per process, and every match
// creates its bots in slot order, so a slot seen twice means a new match started.
const board = { houses: new Set<number>(), target: null as any, seenT: -99 }

export function houseFactory(skill: Skill): BotFactory {
  return (hello, map, rng) => {
    if (board.houses.has(hello.slot)) { board.houses.clear(); board.target = null; board.seenT = -99 }
    board.houses.add(hello.slot)
    const slot = hello.slot
    const duration = hello.config?.match?.duration_s ?? 330
    const knobs = { cubeValue: 1, lootRange: 90, farmNpcs: false, farmCrates: "never" as const, thirdParty: "off" as const, drops: false, duel: false }
    // Hunters chase; the rest of the squad only answers what it can see.
    const hunter = makeBot({ ...hello, practice: false }, map, rng, { ...knobs, name: "fragger", engage: "hunt", engageRange: 200, endgameHunt: 16 })
    const idle = makeBot({ ...hello, practice: false }, map, rng, { ...knobs, name: "survivor", engage: "defend", engageRange: 0, endgameHunt: 0 })
    return {
      name: `house-${skill}`,
      act(obs: any) {
        const mechs = (obs.mechs ?? []).filter((m: any) => m.kind !== "mech" || !board.houses.has(m.id))
        const outsider = mechs.find((m: any) => m.kind === "mech")
        if (outsider) { board.target = outsider; board.seenT = obs.t }
        // Hunters: one early, one more per squad loss, everyone in the last 40%.
        const losses = Math.max(0, board.houses.size + 1 - (obs.alive ?? 16))
        const hunters = obs.t > duration * 0.6 ? 99 : 1 + losses
        const rank = [...board.houses].sort((a, b) => a - b).indexOf(slot)
        const hunting = rank < hunters
        if (hunting && !outsider && board.target && obs.t - board.seenT < 4) mechs.push({ ...board.target })
        const action = (hunting ? hunter : idle).act({ ...obs, mechs })
        if (Array.isArray(action.fire) && rng() < HOLD_FIRE[skill]) action.fire = action.fire.map(() => false)
        return action
      },
    }
  }
}
