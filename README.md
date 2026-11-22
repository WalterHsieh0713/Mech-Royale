# Mech Royale bot

Survival-first TypeScript bot for `mechfight/1`. The arena supplies the map and observations, and the bot emits moves on stdout. Run it with `bun main.ts` or build the supplied Dockerfile.

## Strategies

`profile.ts` defines named strategy profiles, each modelled on a battle-royale playbook (placement play, zone-edge anchoring, early rotation, farming, third-partying, fragging). Select one with `MR_STRATEGY=<name>`. [STRATEGY_RESULTS.md](STRATEGY_RESULTS.md) describes each one and how they fared against each other in simulation.

All profiles share the same controller. It weighs cover, recent contacts, and the shrinking circle before committing to loot, and it collects cubes, the map's collectibles that grow the mech and earn upgrades. It remembers cubes it has seen, values clusters, and goes back for the cubes a defeated mech drops. Farming profiles also shoot NPCs and crates when nobody else is near.

`alive` is treated as counting this mech, as the play client displays it (`alive / config.match.mechs`); set `MR_ALIVE_INCLUDES_SELF=0` to change that. A lobby where nobody else has died well into the match is treated as a practice lobby, which makes the bot more willing to fight. Set `MR_FORCE_SQUAD=1` to force that profile.

During rotations, the bot estimates which side of the next circle has fewer opponents moving in. It compares the space behind each entry in the old circle, observed threats, cover, and time spent outside the zone. Its route planner knows where it can walk off a ledge, such as the stadium rim, and it treats a mech that has a goal but makes no progress as stuck.

The bot can briefly intervene when two visible opponents appear to be fighting. It needs a clear shot at a weakened opponent, aim and damage or sound evidence linking the pair, and a short walk behind solid cover from both. It fires the gun from its current position for up to 1.15 seconds, then withdraws and waits at least eight seconds before another attempt.

## Tests

Run the seeded regression suite with Node 24:

```sh
node --test --test-isolation=none tests/*.test.ts
```

`node tests/baseline.ts` runs the starting revision against the concealment and passing-opponent fixtures when the original Git revision is available.

## Simulator

`sim/` is a headless 16-mech arena that drives bots through the same messages as the live server. Rules that the server does not publish are assumptions collected in `sim/rules.ts`, with variants for checking that a result does not depend on one guess. Simulated results show relative strength under those assumptions; they do not measure live win rate.

```sh
node sim/fetch-arena.ts                                  # download the public campus map to ./arena
node sim/run-match.ts --seed 1 --agents anchor,survivor  # one match, with a results table
node sim/tournament.ts --mode mixed --agents all --matches 100
node sim/tournament.ts --mode field --candidates anchor,survivor --field all --matches 120
```

Without `./arena`, the simulator uses a synthetic town. `legacy` seats the bot from commit 0f3e549 for comparison.
