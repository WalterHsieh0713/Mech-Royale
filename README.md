# Mech Royale bot

Survival-first TypeScript bot for `mechfight/1`. The arena supplies the map and observations, and the bot emits moves on stdout. Run it with `bun main.ts` or build the supplied Dockerfile.

The competitive profile weighs cover, recent contacts, and the shrinking circle before committing to loot. Set `MR_FORCE_SQUAD=1` for the more aggressive practice profile. If your arena confirms that `alive` counts your own mech, set `MR_ALIVE_INCLUDES_SELF=1` to enable explicit final-two behavior.

During rotations, the bot estimates which side of the next circle has fewer opponents moving in. It compares the space behind each entry in the old circle, observed threats, cover, and time spent outside the zone.

The bot can briefly intervene when two visible opponents appear to be fighting. It needs a clear shot at a weakened opponent, aim and damage or sound evidence linking the pair, and a short walk behind solid cover from both. It fires the gun from its current position for up to 1.15 seconds, then withdraws and waits at least eight seconds before another attempt.

Run the seeded synthetic regression suite with Node 24:

```sh
node --test --test-isolation=none tests/*.test.ts
```

`node tests/baseline.ts` runs the starting revision against the concealment and passing-opponent fixtures when the original Git revision is available. Evaluating win rate and placement requires the external arena simulator.
