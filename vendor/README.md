# Vendored Zirbel components

These checked-in components make normal installation, compilation, unit tests and builds independent
of a sibling Zirbel checkout. Source: https://github.com/matapao/zirbel.

- `zirbel-net/` contains the public net SDK used for type checking and optional live tests.
  Its source revision and update guidance are in `zirbel-net/README.md`; its MIT notice is
  `zirbel-net/LICENSE`. Hosted runtime transport is supplied by the host at `/zirbel-net.js`.
- `zirbel-sha256.js` and `.d.ts` contain the public hash fallback used by the standalone game.
  `zirbel-sha256.json` records the source hash and refresh command; retain
  `zirbel-sha256-LICENSE.txt` when redistributing it.
- `zirbel-engineering-1.0.0.tgz` contains the compiled public browser test adapter.
  Its MIT notice is `zirbel-engineering-LICENSE.txt`; keep that notice beside the archive.
  `docs/engineering/browser-package.json` and the lockfile pin its contents and integrity.
  Refresh it through the canonical engineering workflow described in
  `docs/engineering/STANDARD.md`, keeping both consumers and integrity metadata synchronized.

The archive does not bundle its npm dependencies. `npm ci --ignore-scripts` installs those from the
committed lockfile; their own notices remain in their installed packages. Do not commit `node_modules/`.
