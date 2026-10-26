# Public repository source

Redistributable third-party assets are retained with their required notices. Owned code is MIT;
the car remains CC BY 4.0, the bundled fonts remain SIL OFL 1.1, and the installed marker recording
and reviewed optional music sources remain CC0. See the [asset licence audit](ASSET_LICENSE_AUDIT.md)
for the exact scope and evidence.

The public variant is prepared from the verified current source and is intended to start with one
initial commit on `main`. Earlier branches, pull requests and Git history belong to the separately
retained private archive; they are not part of this source tree. No old `.git` directory, generated
builds, installed dependencies, ignored backups or local credential files are copied into the candidate.

## Standalone verification

Use Node.js 24 or newer and install the committed lockfile:

```sh
npm ci --ignore-scripts
npm run verify
```

The complete gate checks formatting, four strict compiler profiles, behavior regressions and both
production builds. A sibling Zirbel checkout and publishing credentials are unnecessary for those
commands. Optional live Chrome/hub scenarios have separate requirements described in `CONTRIBUTING.md`.

The publication review also scans the copied source, including vendored archives, for credentials.
Keep generated output and dependency directories ignored. Repeat verification and the source scan
after any further changes before publication.

## Assets and provenance

The shipped recording `assets/audio/paintball-shot-fabianofa.mp3` is **paintball_shoot1.wav by fabianofa**.
[Its creator's Freesound page](https://freesound.org/people/fabianofa/sounds/98189/) identifies it as
Creative Commons 0. Its adjacent metadata records source, licence, modifications and SHA-256
`7f60036a6406ebc832cfd155579edb2c8194046baa6d175a7b755f60c8a7d4bc`. Preserve that metadata and visible credit.

`assets/audio/radio/today.json` records the withdrawal of **Rainy Day Lofi by Kulakovka**.
The recording is absent from this source tree and must stay absent; retain the withdrawal record.
Music catalogue entries identify optional reviewed CC0 tracks, not bundled recordings.

The car retains CC BY 4.0 attribution and modification notes, fonts retain their SIL OFL notices,
and vendored code retains its MIT notices. See `LICENSE`, `vendor/README.md` and the adjacent asset notices.

## Repository operations

Use the authorized Matapao GitHub App identity for repository creation and pushes. Keep archive
repositories private. A fresh source-only public repository must not be populated by pushing old refs
or merging archive history. Configure dependency alerts and available public security protections
on the new repository; settings from an archived repository do not transfer automatically.

Build workflows use pinned official Actions and read-only repository permissions, with checkout
credential persistence disabled. Optional live-revision notification is separate from ordinary builds
and requires explicit configuration of the GitHub publication environment and secrets.
