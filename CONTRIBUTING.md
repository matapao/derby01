# Contributing

Use Node.js 24 or newer and npm. A standalone checkout supports local play and the complete
verification gate without a Zirbel checkout or publishing credentials:

```sh
npm ci --ignore-scripts
npm run dev
npm run verify
```

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md) and the
[shared engineering standard](docs/engineering/STANDARD.md) before changing code.
Keep changes focused, add behavior regression tests for bugs, and run `npm run verify`.
For visible gameplay or input changes, also exercise the affected browser flow.
The optional scenarios under `test/live/` need Chrome and a separately installed Zirbel checkout;
set `ZIRBEL` to its path. See their file comments for the individual commands.

Keep credentials, local environment files, generated builds and dependency directories out of Git.
Preserve licences and credits for every third-party asset; include its source, creator, licence
and modifications when adding one. Sound candidates listed in `assets/audio/selection.json` are
not installed assets. The withdrawn recording in `assets/audio/radio/today.json` must stay absent.

Report bugs with reproduction steps, browser/device details and the expected behavior.
Use [the security policy](SECURITY.md) for potential vulnerabilities and omit private information
from public reports. Code contributions use the repository's [MIT licence](LICENSE);
third-party work retains its original licence.
