# Architecture

`src/main.ts` binds lifecycle and score presentation before `flow.boot()`.
The runtime import graph is acyclic; dependency tests permit no exceptions.
Portable `src/gameplay/` rules receive state, tuning and effects explicitly, with no DOM, renderer or singleton imports.

## Owners

| Concern                                         | Owner under `src/`                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Setup validation and session state              | `setup.ts`, `state.ts` (`G`)                                                             |
| Boot, menus, rounds and fixed-step coordination | `flow.ts`                                                                                |
| Reverse lifecycle calls                         | `lifecycle.ts`, `gameplay/binding.ts`; bound once by `main.ts`                           |
| Cars and participants                           | `car-types.ts`, `human-types.ts`, `gameplay/model.ts`, `gameplay/participants.ts`        |
| Construction and visual geometry                | `car.ts`, `car-interior.ts`, `car-panel-motion.ts`, `mesh-geometry.ts`, `radar-model.ts` |
| Data/schema validation and revision hooks       | `data.ts`, `blocks/validate.ts`, `kit-data.ts`                                           |
| Seeded maps and colliders                       | `layout.ts`, `town/`, `arena.ts`, `world.ts`                                             |
| Scoring, damage, rounds and systems             | `gameplay/`; `score.ts` and `round.ts` are adapters                                      |
| Geometry and input state                        | `gameplay/geometry.ts`, `gameplay/input.ts`                                              |
| HUD and required DOM/context binding            | `hud.ts`, `hud-types.ts`, `browser-dom.ts`                                               |
| Mechanic jobs, cancellation and typed minigames | `gameplay/mechanic-controller.ts`, `gameplay/minigames.ts`                               |
| Canvas and effects                              | `minigame-view.ts`, `views.ts`, `paint.ts`, `fx.ts`, `sharedfx.ts`, `radar.ts`           |
| Audio and devices                               | `audio.ts`, `control.ts`, `touch.ts`                                                     |
| Session, commands, crew and authority           | `net/context.ts`, `commands.ts`, `crew.ts`, `router.ts`, `session.ts`                    |
| Agent contracts                                 | `agent/`                                                                                 |
| Build and loopback file serving                 | `../tools/build.ts`, `../tools/server.ts`                                                |

## State and lifecycle

- Only `main.ts` imports `flow.ts`; lower modules use its bound lifecycle port.
- Setup data and live cars are distinct. `CarAssembly` stays private; `requireFields` checks attachments before publication.
- Local humans own cameras, viewports and HUDs. Remote occupants retain peer identity/control timing without those resources.
- Minigames use exhaustive `type` unions. Rules receive effects/randomness; canvas presentation stays separate.
- Mechanic cancellation settles a used fuel can before a seat change; unused cans cost nothing. A pour may finish after its task disappears. Flush fuel deltas before the fix request, once.
- Stop the old network role before publishing/starting another. Replicas accept host state only; stale callbacks cannot revive replaced sessions.
- `main.ts` binds `ScoreEvent` to `sharedfx.playScoreEvent` before boot. Delivery is synchronous for recording; popups belong in `points-ui.ts`.
- `D` holds validated tuning. Preserve retained object references; refresh derived values through `onData()`.
- Fixed-step rules own outcomes. Rendering/audio interpolate without changing them. Shared effects use seeded randomness; audio uses independent randomness.
- `gameplay/body-damage.ts` owns collision wear and the loose-before-detached transition. Optional bounded car detail replicates all six panel states. `car-panel-motion.ts` caches hinges and moves existing meshes; dents use canonical rest positions and turrets remain chassis-mounted.
- Panel repair jobs identify the current loosening generation. The host only tightens attached panels after the minimum repair time; stale or detached jobs earn no credit. Successful tightening resets wear and records one mechanic job without restoring chassis health.
- Keep `core.ts` world/car axes and seat indices consistent across cameras, physics and codecs. Geometry results never share mutable scratch state.
- Focus/control loss clears held and one-shot input. Dispose owned resources; preserve shared geometry/materials.
- Relative asset URLs support versioned mounts. Build before play. Visible front-cover credits describe installed assets; candidates stay separate.

## Compiler and wire boundaries

The root compiler profile extends the complete shared strict baseline for every browser module;
Node tools and maintained tests inherit every supplemental flag through their own environment profile.
`tsconfig.boundaries.json` retains explicit independent coverage, and `tsconfig.gameplay.json` checks
portable rules without DOM/Node types. Indexed table selections either retain an optional result or
reject a missing required value before it can become an invalid render or simulation value.
Explicit car/HUD/minigame contracts cannot become arbitrary property bags; `test/types/` guards widening.

`net/effect-types.ts` derives effect argument tuples. Append-only wire IDs must match codecs;
the registry rejects duplicate IDs and recording through the wrong function. Invalid/truncated reads never reach presentation.
Rate accounting settles on unknown IDs and exceptions. The reserved explosion cause stays reserved and is rejected.
The local HTTP server confines reads to its real build root and binds loopback only.

## Music and browser services

`music-settings.ts` validates preferences; `music-player.ts` owns one voice and object-URL cleanup.
`music-library.ts` owns bounded transactional local storage. `music-model.ts` accepts reviewed catalog IDs and decoded queues, never arbitrary room audio URLs.
`net/music-room.ts` shares host choices, without recordings or listener volumes.
`music-bridge.ts` uses a same-origin, versioned, throttled MessagePort. Hosted storage belongs to Zirbel's trusted player outside the opaque game frame; uploads are hash-verified before commit.
Standalone storage remains a fallback pending a distributable shared adapter.
`music-hash.ts` uses Web Crypto or the bundled public Zirbel hash owner on HTTP LAN;
`tools/vendor-hash.ts` preserves that export's source hash/license. `music-ui.ts` renders safe credit text/links.

`onboarding.ts` persists its versioned guide only on Skip/Finish.
`render-quality.ts` owns pixel budgets/hysteresis; `world.ts` applies them without Retina supersampling or post-processing.

## Competition and statistics

`gameplay/competition*` owns rules and report/record validation. `competition.ts` observes authoritative events and retains the last report; shot identity survives seat changes.
`competition-ui.ts` separates named in-game reports from numeric records. `flow.ts` owns round sampling and bounded report delivery to replicas. Precision includes only observable supported actions.

`gameplay/metrics.ts` derives round-relative points, wrecks, completed rounds and duration.
Only the current host emits through optional `net.metric`; no identities enter reports.
Providers label these browser-host results. Older SDKs continue without a second metrics protocol.

## Verify

Run `npm run verify`: formatting, compiler profiles, Node regressions and both builds.
For browser changes, exercise setup → start → pause/resume → setup and the affected seat/device; audio needs a gesture. Repeat rounds for lifecycle changes. Use `?debug` or `?autostart` as needed.
Run affected `test/live/` multiplayer scenarios against a local Zirbel hub. Dependency changes also need `npm audit --omit=dev`.
Passing checks cover their scenarios, not complete gameplay correctness.
