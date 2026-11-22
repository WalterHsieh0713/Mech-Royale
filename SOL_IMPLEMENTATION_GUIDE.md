# Mech Royale survival and endgame controller

## Assignment for Sol

Implement a bot that reaches the last fight with health, a usable weapon, enough energy to move, and cover it can actually fight from. Optimize for wins, with reaching the final two and arriving ready to fight as separate diagnostics. This ordering is provisional until the arena's scoring rules are known. Preserve the `mechfight/1` interface and the seeded `makeBot(hello, map, rng)` entry point. Run the controller locally in Bun. The earlier research and longer-term training options are in [BOT_AI_PLAN.md](BOT_AI_PLAN.md).

Start with the concealment and firing scenarios below. The current bot can choose `hide` for movement and then shoot an NPC or crate in `quietFarm` during the same observation. Its practice heuristic also initially treats an ordinary opening as practice, which relaxes combat and farming decisions. These are the first two behaviors to address because they can expose a stationary mech even when its hiding spot is excellent.

## What the bot should do in a match

| Situation | Desired decision | Evidence that changes it |
| --- | --- | --- |
| Opening, poor equipment | Collect a reachable quiet pickup or cube near cover, then reassess. Consider firing on a crate only for a worthwhile gain with time and cover to spare. | Nearby activity, a missed pickup, or a closing escape window can make the next item too expensive. |
| Equipped and unobserved | Hold solid cover with a timely exit toward the next circle. Scan plausible approaches and reload in a safe window. | A new threat angle, damage, or a shrinking exit window invalidates the hold. |
| Someone passes nearby | Stay concealed if the opponent has no credible firing angle and continuing past is safe. | Incoming fire or an opponent cutting off the only exit can justify moving or defending immediately. |
| Route is contested | Compare waiting for contact to pass, taking a covered detour, and crossing now. | Compare each route with its zone deadline. An early crossing can be safer than a longer detour that strands the bot. |
| Several opponents remain late | Occupy cover on the playable side, preserve energy, and let other fights resolve when possible. | Taking a position before the next shrink can matter more than another upgrade. |
| Last opponent | Take a favorable visible shot from cover. If the opponent is missing, watch likely entries or move to a better angle before cover expires. | Break sight to reload or dodge, then reacquire. Hard cover with a safe firing angle can justify staying still. |

Do not assume that the other players perceive every action. Treat firing or boosting near contacts as a disclosure risk to be measured. In particular, suppressing boosts everywhere can make a crossing longer and more dangerous.

## Decision contract

Separate **intent** from **execution** inside `bot.ts`. Each strategic decision returns a mode, optional goal, expiry, reason, and permissions for player engagement, resource firing, and energy spending. Use the existing controllers to translate those into protocol actions. Recheck immediate danger and validate the chosen action on every processed observation. Refresh slower route and loot choices when evidence, the zone, or the goal changes.

1. **Check immediate survival.** Evaluate incoming projectiles, fresh damage, and whether any safe route still has time to spare. When dodging during a rotation, prefer a clear lateral step that also progresses toward safety, then resume the route. A blocked dodge must not send the mech repeatedly into a wall.
2. **Discard infeasible plans.** Reject unreachable loot, partial routes treated as completed trips, contested drops, and excursions that leave insufficient time or energy to reach safety. A partial path can still provide emergency progress if its next segment is safe.
3. **Compare feasible plans.** Always include continuing the current plan and holding the current position. Score each candidate on incremental combat readiness, cover at the destination, and useful zone progress, minus risk along the journey, time exposed at the objective, and energy spent. Give up marginal loot once equipped. Use stable tie breaking and seeded sampling.
4. **Commit briefly.** Keep the current goal through small score fluctuations. Switch immediately when it becomes unsafe, unreachable, depleted, or too late. Record the reason for the switch.
5. **Enforce the decision at emission.** A movement label alone cannot keep the bot quiet. Apply the same intent to target selection, crate/NPC farming, automatic reload, laser charge/release, and boost. Exercise the charge path with a fixture before treating release as harmless. Keep the debug label within the 80-character limit in `main.ts`.

The default competitive profile should require evidence before engaging a player merely passing by. Use an explicit practice profile or a documented arena signal when available. Treat an unknown lobby as competitive. Use `obs.alive` for duel detection only after verifying whether it counts self and which entities count. Until then, a visible opponent, urgent circle, and lack of a safer playable position can still trigger a fight.

## Concealment, contacts, and paths

**Remember the observation and its age.** Keep the last visible position, velocity, and game time per observed opponent. For the first implementation, distribute a bounded set of weighted hypotheses among reachable positions near that sighting. Favor continuation of recent movement briefly, then spread weight toward accessible exits. Derive travel distance from elapsed game time and verified speed bounds. Include stopping as a possibility. Fade the total weight of old evidence. A remembered contact influences scanning, movement, and loot risk. Player targeting continues to require a current visible target.

**Represent sound as an area.** Anchor each anonymous sound to the bot's position and the reported bearing at the instant it was heard. Retain the reported distance category. Confirm bearing convention and distance semantics from the protocol or fixtures before converting to world coordinates or meters. Merge nearby repeated cues conservatively. Never turn a single bearing into an exact enemy or increment the known player count from it. Only clear a hypothesis on an empty observation if sensor coverage there is established. Treat skipped ticks using elapsed `obs.t`. Check whether events are cumulative before merging batched observations in `main.ts`.

**Distinguish concealment from protection.** `GameMap.see` accounts for foliage. `GameMap.los` checks solid terrain and structures. Rank a location behind solid cover above foliage alone when both face an active threat. Sample lines from likely opponent locations to the mech at the destination using its current size. Use `expoAt` as a cheap estimate of general openness. Prefer a spot with at least one reachable exit toward the next circle and a second exit when practical. Recheck a chosen spot when incoming evidence changes. Holding should neither reroll a good spot on a timer alone nor freeze the bot after the spot becomes exposed.

**Price the whole trip.** For a loot excursion evaluate current position → item → playable cover, including collection or farming time. For a rotation compare a direct route and a covered one. Estimate arrival at intermediate points from path length, observed speed, terrain, and affordable boost. Use `zoneAt` to check each sample at its estimated arrival. Reserve a margin for uncertainty and stuck recovery. If all options incur zone exposure, pick the reachable route with the least expected harm and keep moving.

**Carry route risk through execution.** Pass a bounded nonnegative threat cost into the existing `GameMap.path(..., extraCost)`. Make string pulling in `map.ts` and look-ahead in `followPath` compare risk along each shortcut with risk on the replaced segment. Walkability alone is insufficient. Compare integrated risk and peak danger so a shortcut cannot quietly cross one highly exposed tile. Validate the final goal segment and keep completion status with the path. On a failed optional loot path, discard that goal temporarily. Replace the existing unconditional direct-steering fallback with a checked segment or another reachable goal.

## Strength before the final fight

Use a small set of measurable readiness features. Start with health fraction, usable weapon at expected range, ammo or charge status, and energy remaining after reaching cover. Add cube and upgrade effects when their game semantics are verified. Derive ranges, charge times, and energy costs from the current weapon stats. Count a pickup's *incremental* value over the weapon that would be dropped.

| Decision | First implementation |
| --- | --- |
| Take a quiet item | Compare the expected loadout after collection with the current loadout. Favor a useful item already along the rotation over a larger detour with marginal benefit. |
| Spend time firing on a resource | Include noise, time until the reward can be collected, likely ammo use, and the route out. While hidden, require a deliberate change to the farming intent before firing. Stop if new evidence makes the excursion unsafe. |
| Pick an upgrade | Rank only the offered choices. Use known effects and current loadout to value survivability, damage at expected range, and energy availability. Fall back to the existing priority for unknown effects or ties. |
| Handle a weak loadout late | Compare one short safe improvement with taking firing cover now. Accept a weaker weapon if the detour would leave the bot crossing the final circle in the open. |
| Enter the duel | Use the existing lead, charge, dodge, and spacing controls. Take a clean opening from playable cover even when the opponent has not fired first. Avoid chasing a lost target into an exposed lane. |

Use a worked scenario as the first demonstration. Put a healthy mech behind a wall with a usable weapon, a visible crate, and a high-value pickup beyond a corridor. Add footsteps consistent with the corridor. With comfortable zone slack the bot should hold or take a covered pickup route. Removing the footsteps and weakening its loadout should make collecting more attractive. Shortening the zone deadline should cancel the detour. Replacing the crate with the visible final opponent at favorable range should permit a shot. This one family of fixtures distinguishes informed hiding from permanent passivity.

## Implementation order and checks

| Step | Changes Sol should make | Evidence to produce |
| --- | --- | --- |
| 1. Establish the baseline | Keep a runnable reference to the starting revision. Build a small seeded Bun harness around `makeBot` and `GameMap` using synthetic terrain, config, and sequences of observations. Capture emitted actions and timing. | Replaying the same fixtures and seed yields identical actions. Include a reproduction of hiding while firing on a crate and the opening practice assumption. Clearly label synthetic results. |
| 2. Make concealment enforceable | Introduce the competitive profile and intent permissions. Wire farming and player targeting through them. Leave the proven aim solver available for authorized shots. | Hidden with a visible crate emits no farming shot. A passing mech does not cause an elective attack. Immediate danger permits defense or escape. Exercise charged and uncharged laser cases. |
| 3. Add contact memory and safer paths | Implement the bounded hypotheses, anonymous sound evidence, cover scoring, path risk, and shortcut checks. | In a two-route map, a recent sighting makes the bot use the covered passage when time allows. Both shortcut mechanisms preserve it. As the sighting ages, the penalty fades. An unreachable exit does not count as cover. |
| 4. Add strengthening and duel decisions | Rank loot excursions, upgrades and fighting positions with zone arrival times and readiness. Make final engagement explicit. | Run the worked scenario above. Also verify a low-energy mech retains escape energy, and a healthy final-two mech with a clean opening can fire before being attacked. |
| 5. Evaluate closed-loop play | Use the official simulator and rules when available. Run paired baseline/candidate matches with matched seeds, slots, and opponents. Evaluate against passive, aggressive, and mixed opponents and hold out seeds for final comparison. | Report sample counts, wins, final-two rate, and wins conditional on reaching final two. Include uncertainty on paired differences. Check p95/p99 action latency, failures, and missed deadlines against the real budget. |

For steps 1–4, inspect the *emitted movement and fire actions*, not only a mode label. Keep diagnostic traces off protocol stdout. Include mode changes, evidence age, route risk, estimated zone slack, rejected loot reason, and final-two entry health/loadout when observable. Distinguish exact detection events from proxies such as first incoming damage. Include new runtime modules in the Dockerfile's explicit copy list and exercise the stdin/stdout entry point.

If the external arena remains unavailable, complete fixture-based work and report the precise remaining integration checks. Observation playback can establish what the controller would choose on a recorded frame. Match outcomes require a running environment that responds to the new actions. If more games reach the final two but fewer turn into wins, inspect entry resources, arrival timing, and missed firing opportunities before increasing the incentive to hide.

## Learning after the first measured version

Start by tuning a handful of named weights offline, such as contact decay time, acceptable loot detour, escape energy reserve, and the cost of crossing an exposed lane. Keep units in configuration, log the features behind decisions, freeze evaluation seeds, and compare with the hand-set policy. Train a small model for one decision only after there are enough representative matches. A useful first prediction is the chance of taking damage before reaching the next cover on the chosen route. Compare its predictions with held-out outcomes and then evaluate whether using them improves actual wins. A model trained only on routes the old bot took will need fresh trials for unfamiliar choices.

## Prompt to give Sol

> Implement the Mech Royale survival and endgame controller in SOL_IMPLEMENTATION_GUIDE.md. Start by reproducing the concealment/firing conflict, then follow steps 1–4 through the real bot entry point. Use BOT_AI_PLAN.md for research context. Run the scenario checks after each change. If the official simulator is available, complete step 5 and compare with the original bot. Report observed behavior, unresolved protocol assumptions, and measured match outcomes separately. Keep match decisions local and reproducible.
