// Strategy profiles. Each one is a named set of knobs read by bot.ts, modelled on a
// recognisable battle-royale playbook. The arena simulator (sim/) races them against
// each other; DEFAULT_PROFILE is whichever has measured best there.

export type Rotation = "deadline" | "early" | "edge"
export type Engage = "defend" | "favorable" | "hunt"
export type ThirdParty = "off" | "burst" | "vulture"

export interface Profile {
  name: string
  /** When to start a fight with a visible mech that has not attacked us. */
  engage: Engage
  /** Farthest distance at which an elective fight may start. */
  engageRange: number
  /** Multiplier on the value of a cube (the map's collectible dots). */
  cubeValue: number
  /** Farthest excursion for loot or cubes before the late game. */
  lootRange: number
  /** Shoot NPCs for their cubes when nobody else is around. */
  farmNpcs: boolean
  /** Break crates: never, only while the second weapon slot is empty, or whenever quiet. */
  farmCrates: "never" | "needy" | "always"
  /** Farming stops once the announced circle is this small (meters). */
  farmUntilRadius: number
  /** When and where to rotate into the next circle. */
  rotation: Rotation
  /** Fight evidence: off, a short covered burst, or moving toward fights to finish the weak. */
  thirdParty: ThirdParty
  /** Contest supply drops. */
  drops: boolean
  /** With this many mechs alive (self included) or fewer, hunt the nearest contact. 0 = never. */
  endgameHunt: number
}

const base: Profile = {
  name: "survivor",
  engage: "defend",
  engageRange: 0,
  cubeValue: 1,
  lootRange: 75,
  farmNpcs: false,
  farmCrates: "needy",
  farmUntilRadius: 45,
  rotation: "deadline",
  thirdParty: "burst",
  drops: true,
  endgameHunt: 2,
}

export const PROFILES: Record<string, Profile> = {
  // The concealment-first controller from SOL_IMPLEMENTATION_GUIDE.md, unchanged in spirit.
  survivor: base,
  // FNCS placement play: never take an optional fight or detour; hide and outlast.
  placement: { ...base, name: "placement", cubeValue: 0.4, lootRange: 35, farmCrates: "never", thirdParty: "off", drops: false, endgameHunt: 0 },
  // Fortnite early-game "farm and scale": bank cubes from NPCs, crates and the ground before
  // anyone else is close, then play the survivor game with the upgrades.
  scaler: { ...base, name: "scaler", cubeValue: 2, lootRange: 130, farmNpcs: true, farmCrates: "always", farmUntilRadius: 70 },
  // ALGS-style early rotation: get into the next ring first and claim deep cover before
  // the traffic arrives; only loot what lies inside it.
  rotator: { ...base, name: "rotator", rotation: "early", cubeValue: 1.4, lootRange: 90, farmNpcs: true },
  // Fortnite edge play: farm until the deadline, then ride just inside the edge so threats
  // can only come from one side.
  edge: { ...base, name: "edge", rotation: "edge", cubeValue: 1.6, lootRange: 110, farmNpcs: true, farmCrates: "always" },
  // Apex third-party specialist: walk toward gunfire, finish whoever is losing, take the cubes.
  vulture: { ...base, name: "vulture", thirdParty: "vulture", cubeValue: 1.5, lootRange: 110, farmNpcs: true, endgameHunt: 3 },
  // Hot-drop fragger: take every fight it can see that is not obviously lost.
  fragger: { ...base, name: "fragger", engage: "hunt", engageRange: 150, cubeValue: 1.5, lootRange: 110, farmNpcs: true, farmCrates: "always", endgameHunt: 16 },
  // Apex "anchor": hold strong cover on the edge of the next ring, take cubes that are
  // close, never go looking for a fight before the final two.
  anchor: { ...base, name: "anchor", rotation: "edge", cubeValue: 1.2, lootRange: 70, farmCrates: "needy", thirdParty: "off", drops: false },
  // Fortnite "farm early, then turtle": bank NPC cubes during the first circle only.
  farmer: { ...base, name: "farmer", cubeValue: 1.6, lootRange: 110, farmNpcs: true, farmUntilRadius: 200, farmCrates: "needy", thirdParty: "off", drops: false },
  // Selective aggression: farm hard early, take only favorable fights, hunt when few remain.
  hybrid: {
    ...base, name: "hybrid", engage: "favorable", engageRange: 90, cubeValue: 2, lootRange: 130, farmNpcs: true,
    farmCrates: "always", farmUntilRadius: 60, rotation: "edge", thirdParty: "vulture", endgameHunt: 4,
  },
}

export const DEFAULT_PROFILE = "survivor"

export function resolveProfile(spec?: string | Partial<Profile>): Profile {
  if (spec && typeof spec === "object") return { ...PROFILES[spec.name ?? DEFAULT_PROFILE] ?? base, ...spec }
  const name = spec ?? (typeof process !== "undefined" ? process.env.MR_STRATEGY : undefined) ?? DEFAULT_PROFILE
  return PROFILES[name] ?? PROFILES[DEFAULT_PROFILE]
}
