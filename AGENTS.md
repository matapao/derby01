# Working in derby01

- Read [the shared engineering standard](docs/engineering/STANDARD.md) and [adoption exceptions](docs/engineering/ADOPTION.md) before coding; use its language, library, testing and architecture choices.

## Before and after a change

- Read `docs/architecture.md` and the relevant tests before editing. Keep changes focused and preserve unrelated work.
- Run `npm run verify` before delivery. Report failures and checks you could not run. Server tests need loopback networking; live multiplayer tests additionally need a local zirbel hub.
- Add regression tests for fixed bugs and changed input boundaries. For visual/input changes, also play the affected browser flow; unit tests do not exercise WebGL or device APIs.
- Keep `README.md` at 50 lines or fewer; put detailed explanations in `docs/`.

## Module and safety rules

- Keep pure logic independent of the DOM, WebGL and global game state. `setup.ts`, `math.ts` and `net/protocol.ts` must stay safe to import in Node.
- Audio lives in `audio.ts`; visual particles/debris live in `fx.ts`. Import sound directly rather than through rendering code.
- Import `G` from `state.ts`, kit tuning from `kit-data.ts`, and transforms/intersections from `gameplay/geometry.ts`. Do not import a renderer or controller just to obtain data or a helper.
- `src/gameplay/` is a strict, independent rule layer. It may only import other gameplay modules at runtime. Give rules explicit state and dependencies; emit typed events for presentation.
- Do not restore catch-all index signatures or `any` fields on cars, humans, HUDs or minigames. Local and remote humans are distinct; remote participants never own a camera or HUD.
- Keep the entire runtime import graph acyclic. The dependency test has no legacy exceptions. Only `main.ts` imports `flow.ts`; lower modules use the explicitly bound lifecycle port.
- Read session utilities from `net/context.ts`; only `flow.ts` starts `net/session.ts`. Player commands live in `net/commands.ts`, crew publishing in `net/crew.ts`, and role/message rules in `net/router.ts`.
- Minigame transitions and mechanic job ownership live under `gameplay/`; canvas drawing lives in `minigame-view.ts`. Keep the keyed state map and exhaustive dispatch together. Do not index a union of game states through an untyped registry.
- Build HUDs through `bindHumanHud()` so missing selectors and unavailable canvas contexts fail during construction. Use the typed HUD cache keys.
- Bind score presentation in `main.ts` before boot. Keep the `ScoreEvent` switch exhaustive and synchronous so shared effects are recorded in order.
- New standalone modules should have explicit types and strict checking. Add them to `tsconfig.boundaries.json` when they can be checked independently; do not weaken checks to silence errors.
- The entire browser tree and tools are strict; keep them that way. The complete shared supplemental compiler flags apply to every maintained browser module, Node tool and test, as well as the independent boundary profiles. Avoid accessing imported mutable state at module initialization; initialize after `boot()` or from `onData()` as appropriate. Bind lifecycle and score presentation once in `main.ts` before boot; missing or duplicate bindings fail explicitly.
- Treat saved settings, host data and network messages as untrusted. Decode unknown values field by field, bound sizes and rates, and keep the host authoritative.
- Use `textContent` for external text. Escape dynamic values before inserting HTML. Never add `eval`, remote scripts, credentials or external telemetry.
- Network message/effect ids are append-only. Change `PROTOCOL` for incompatible wire changes and update both sender and receiver tests.
- Dispose resources owned by a module; do not dispose shared car geometry/materials. Preserve deterministic shared effects and fixed-step simulation.
- Tune gameplay through `data/` and schemas. Keep the block manifest and validators in sync.

## Credits

- Always credit every third-party asset used in this game, even when attribution is optional.
- Put credits on the front/setup page, integrated beneath the cover/title content. Keep them visible without flipping the cover or opening a disclosure.
- Include the asset title, creator, source link, licence, and any required modification notice.
- When adding sounds, update the visible cover credits and retain their source/licence information with the assets. Candidate sounds are not used assets and must not be presented as installed.
