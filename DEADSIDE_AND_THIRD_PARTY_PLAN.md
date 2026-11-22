# Sol High execution plan for rotations and third parties

The goal is to arrive at the final fight healthy and equipped. Crossing on the quiet side of a moving circle can help. So can a short shot at a weakened opponent whose attention is elsewhere. Both decisions must leave the mech enough time and cover to survive.

## Starting point

The workspace already contains a first implementation. Read the rotation code in `strategy.ts` and `bot.ts`, the fight checks in `third-party.ts`, and the two corresponding scenario test files. Preserve existing work. The last change before handoff added scoring at the point where the route first crosses the announced circle. That integration still needs a full verification run.

## Execution order

1. **Verify the crossing.** Use a shifted circle and two routes to the same destination that enter on different sides. Check that crossing pressure is lower on the side with less old-circle area feeding into it. Include a route with a waypoint already past the boundary, and a concentric circle where geometry gives neither side an advantage.
2. **Verify actual movement.** Compare a quiet approach with an approach containing recent contact evidence. In the early rotation fixture, follow emitted moves until the mech reaches the next circle. In the urgent fixture, verify that the mech takes the timely entrance. Check that the movement controller uses the same route comparison that selected the destination, including before rotation becomes urgent. Correct any mismatch and preserve hard-cover and partial-path behavior.
3. **Verify the opportunity and exit.** Observe a pair of visible opponents, with one aiming at the other. Use a fresh observed health drop or gunfire consistent with the attacker's bearing. Require a ready gun, a vulnerable target, sufficient health and energy, time before rotation, and a walkable exit behind solid cover from both opponents. Exercise the positive case, then remove one piece of evidence or make the escape unsafe. Verify emitted shots, movement, burst expiry and cooldown. Immediate danger and zone deadlines take priority.
4. **Finish integration.** Fix defects these checks reveal, run the full regression suite with `node --test --test-isolation=none tests/*.test.ts`, check the runtime modules in the Dockerfile, and check the diff for whitespace errors. Report the exact result. If a real arena runner is available, compare match outcomes on paired seeds. Synthetic scenarios alone establish behavior and leave win rate unmeasured.

Keep changes scoped to these two tactics. The burst duration and cooldown are initial tuning choices. Preserve the competitive profile's preference for concealment when the evidence is ambiguous.
