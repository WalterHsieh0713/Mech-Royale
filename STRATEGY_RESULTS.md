# Strategy tournament results

Date: November 22, 2026. All numbers come from the offline simulator in `sim/`, not from the live game. The simulator uses the real campus map, the `hello`/`obs`/action messages as the client and this repository reveal them, and modelled values (`sim/rules.ts`) for everything the server keeps private: damage, cube effects, NPCs, crates, the storm schedule. The rankings below held up when those guesses were varied, but they are evidence, not proof. Confirm them in live matches.

## Strategies

Each strategy is a profile in `profile.ts`, applied to the same bot (`MR_STRATEGY=<name>`).

| Profile | Pro playbook it models | What it does differently |
| --- | --- | --- |
| survivor | (the existing controller) | Concealment first, defends when attacked, short third-party bursts. |
| placement | FNCS placement play | Never takes an optional fight or long detour; hides and outlasts. |
| anchor | Apex "anchor" / zone-edge hold | Holds cover just inside the edge of the next ring, picks up cubes within 70 m, no third-partying. |
| edge | Fortnite edge rotation | Farms until the deadline, then rides the edge of the next circle; farms NPCs and crates. |
| rotator | ALGS early rotation | Moves into the next ring as soon as it is announced and claims deep cover; loots only inside it. |
| farmer | Fortnite "farm early, turtle late" | Shoots NPCs for cubes during the first circle only, then hides. |
| scaler | Fortnite "farm and scale" | Farms NPCs, crates and cubes hard until the circle is 70 m. |
| vulture | Apex third-party specialist | Walks toward gunfire, finishes broken mechs, takes their cubes. |
| fragger | Hot-drop W-key | Takes every visible fight it is not obviously losing. |
| hybrid | Mixed | Favorable fights only, edge rotation, vulture, hunts in the last four. |
| legacy | (commit 0f3e549) | The hand-written bot before the planned rewrite, as a reference. |

## Results

### All strategies, base rules (110 matches, about 196 seats each)

| Agent | Mean place | Win % | Top 4 % | Cubes |
| --- | --- | --- | --- | --- |
| placement | 7.48 | 8.7 | 36.2 | 9.9 |
| edge | 7.87 | 6.6 | 28.1 | 19.7 |
| rotator | 7.88 | 5.6 | 28.6 | 15.3 |
| survivor | 7.95 | 5.1 | 33.3 | 15.8 |
| vulture | 8.19 | 7.7 | 25.0 | 16.7 |
| hybrid | 8.72 | 7.2 | 23.6 | 15.5 |
| scaler | 8.86 | 6.6 | 19.9 | 18.1 |
| legacy | 9.69 | 3.6 | 16.0 | 12.9 |
| fragger | 9.86 | 5.1 | 14.3 | 10.9 |

The 95% interval on mean place is about ±0.65. Chance is place 8.5 and 6.25% wins.

### Leading strategies, base rules (280 matches, 640 seats each)

| Agent | Mean place | Win % | Top 4 % | Cubes |
| --- | --- | --- | --- | --- |
| placement | 8.17 | 5.2 | 28.3 | 7.7 |
| anchor | 8.19 | 8.1 | 27.3 | 17.7 |
| survivor | 8.32 | 6.1 | 27.8 | 15.8 |
| farmer | 8.55 | 6.6 | 23.3 | 17.4 |
| rotator | 8.63 | 4.8 | 24.5 | 14.4 |
| edge | 8.65 | 7.7 | 24.5 | 19.0 |
| vulture | 9.00 | 5.3 | 19.2 | 15.2 |

### Rule variants (90 matches each, 288 seats per cell)

Win % / mean place:

| Agent | base | weak cubes | strong cubes | double damage | fast storm | average |
| --- | --- | --- | --- | --- | --- | --- |
| anchor | 8.1 / 8.19 | 7.6 / 8.65 | 7.3 / 8.38 | 4.9 / 8.41 | 7.3 / 8.79 | 7.0 / 8.48 |
| edge | 7.7 / 8.65 | 4.9 / 9.25 | 10.1 / 8.41 | 6.9 / 8.81 | 9.4 / 8.78 | 7.8 / 8.78 |
| survivor | 6.1 / 8.32 | 5.9 / 8.36 | 5.9 / 8.25 | 6.6 / 8.59 | 5.9 / 8.24 | 6.1 / 8.35 |
| placement | 5.2 / 8.17 | 8.3 / 7.14 | 1.7 / 8.52 | 4.9 / 8.16 | 4.5 / 7.91 | 4.9 / 7.98 |
| farmer | 6.6 / 8.55 | 4.5 / 9.10 | 6.3 / 8.94 | 8.0 / 8.53 | 4.2 / 8.78 | 5.9 / 8.78 |

Variant cells are noisy: about ±3 points of win rate and ±0.55 places at 95%.

## What the simulations say

1. **Taking every fight loses.** The fragger was last or next to last everywhere. Elective fights at full health invite a third party, which matches the pro advice about 50/50 fights.
2. **Winners snowball on cubes.** Winners averaged 56 cubes and 18 upgrades; mechs that finished outside the top four averaged 10 cubes. Most come from collecting the cubes a defeated mech drops, so picking up nearby dots, especially after a kill, decides the final fight.
3. **Hiding maximizes placement; collecting cubes maximizes wins.** Placement play has the best average finish but the lowest win rate once cubes matter, because it reaches the final two weaker. Anchor, edge and farmer convert more top finishes into wins.
4. **Edge rotation helps wins.** Both edge-riding profiles (anchor and edge) have the highest win rates: threats come from one side and fights in the middle of the circle resolve first.
5. **Walking toward gunfire (vulture) did not pay** in this model. Stalking costs more health than the extra cubes are worth.

## Recommendation

Use **anchor** when the competition rewards wins, and **placement** when it rewards average placement. The default stays `survivor` until the field test below is in; see the final section.

## Reproducing

```sh
node sim/fetch-arena.ts                     # once: downloads the public map to ./arena
node sim/tournament.ts --mode mixed --agents all --matches 110 --out sim/results/all.json
node sim/tournament.ts --mode field --candidates anchor,survivor --field all --matches 120
node sim/tournament.ts --mode mixed --agents anchor,placement --variant every --matches 60
node sim/report.ts sim/results/all.json      # per-variant tables
node sim/run-match.ts --seed 3 --agents anchor,edge --trace 4   # follow one mech
```
