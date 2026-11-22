# Overnight results (Nov 22, 2026)

Practice = 96 matches vs 15 house bots acting as one squad, fresh seeds every submission.
Qualifying needs a top-32 practice score; 32nd place was **5.96** at 6:15 AM EST (388 teams).

## Team practice scores

| Time (EST) | Who | Commit | What | Score |
|---|---|---|---|---|
| 3:53 | Josh | 0f3e549 | his bot, base | 4.82 |
| 3:58 | Josh | 637d615 | always duel | 4.91 |
| 4:21 | Walter | ce3e56d | our rewrite | rejected: 9/300 answers over 50 ms |
| 4:45 | Josh | 4d26cbb | dmgup | 4.71 |
| 5:20 | Josh | 7aac90e | regen | 4.92 |
| 5:23 | Walter | 7d0ad12 | ours, survivor + timing fix | 3.44 |
| 5:48 | Josh | b07d252 | far | 4.68 |
| 5:52 | Walter | d10ad84 | ours, duel default | 4.00 |
| 6:00 | Josh | de00e24 | near | 4.91 |
| 6:04 | Josh | a10cc88 | solo | 5.02 |
| 6:21 | Josh | bab88ed | solo2 | 4.82 |
| 6:24 | Josh | aed10eb | focus | 4.61 |
| 6:49 | Walter | 656a69d | ours, duel + collect cubes after kills | 4.41 |
| 6:53 | Josh | f4e9197 | bold | 4.63 |
| 7:02 | Josh | 35c8489 | jink | 4.42 |
| 7:07 | Josh | 30fd46e | noprovoke | **5.04** (team best) |
| 7:21 | Walter | 28a5fce | ours, hunter (go after contacts) | 4.05 |
| 7:26 | Josh | 06a74cc | ears | 4.98 |
| 7:49 | Walter | 1bfbacd | ours, duel + return fire while evading | 4.45 |
| 7:55 | Josh | 3fbae98 | (Josh) | 4.78 |

## What this says

- Josh's bot is a stable ~4.8 (sd ~0.2 across 13 runs); his variants are all inside that noise.
- Our rewrite is a stable ~4.0-4.45. Fixes that were clearly real in live matches (collecting
  cubes after kills, returning fire) did not move the practice score beyond noise.
- Hiding (survivor 3.44) and hunting (4.05) are both worse than duelling.
- Nobody on the team is near the 5.96 cutoff; small variants of either bot will not get there.

## What was fixed in our bot tonight

- Answers every observation within 33 ms from a worker thread (main.ts/brain.ts); the
  rejection is gone. Checked in the grader's exact docker limits: max 16-26 ms.
- Killed rivals are cleared from the danger map; duel mode grabs nearby cubes/loot.
  Before: 0 cubes, 0 upgrades every live match. After: 4-5 cubes, 2 upgrades in wins.
- Duel mode returns fire while breaking away.
- Commit signing is off for this repo only (`git config --local commit.gpgsign false`).

## Real game numbers (from the live server's hello)

- Each cube: +4% max HP and +4% damage (cap 10 cubes = +40%); upgrades at 1,3,6,10,15... cubes.
  A kill drops the victim's cubes + 2.
- Laser 315 damage per charged shot (0.75 s charge, 1.65 s cooldown, 280 m), fires alongside the gun.
- Regen 45 HP/s after 5 s without damage; nanites upgrade: +60% and 1.5 s sooner.
- Live matches are 240 s; zone phases in the hello `config.zone`.

## Tools added

- `sim/live/bridge.ts`: plays our bot (or another folder via `--dir`) in live public
  matches and logs place, kills, cubes, upgrades, damage dealt/taken per match.
- `sim/replay-timing.ts` + `sim/profile-act.ts`: answer-time checks, incl. in docker.
- `sim/house.ts`: a practice-squad stand-in for the simulator. **Uncalibrated**: everyone
  scores ~0.5 there; do not use for decisions.
- Local branch `josh-regen-relay` (worktree `../mr-josh-relay`): Josh's regen bot inside our
  on-time relay. Not submitted: the per-submission "wait" number turned out not to be
  answer time, so there was no evidence Josh's bot answers late.

## Ideas not yet tried (each needs a submission to judge)

- Farm crates/NPC cubes hard in the first 30-60 s, while only one weak hunter is out.
- Value the laser pickup much higher (315 per shot changes most duels).
- Pick `nanites` early and break line of sight for 3.5 s to heal between hunters.
- Lightning/mortar against the late swarm: squad bots clump and lightning chains twice.
