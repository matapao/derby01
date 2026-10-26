# Security

This game is under development. Security fixes are made on the current main branch;
older snapshots have no separate security maintenance commitment.

For a suspected vulnerability, check the repository's **Security** tab for private reporting.
If that option is unavailable, open an issue asking the maintainer for a private reporting channel,
without including exploit details, credentials, personal information or affected private data.
Include reproduction steps and the affected revision once a private channel is established.

`npm run dev` serves the generated game on loopback for local development. Use a separately
configured HTTP server for hosted builds, and keep its credentials outside the game tree.
The standalone game needs no secrets or account credentials. Optional live-revision notification
uses GitHub environment secrets and is disabled unless `ZIRBEL_LIVE` is explicitly enabled.

Run `npm audit` when reviewing dependencies and `npm run verify` before submitting fixes.
Dependency advisories are only one part of security review; do not place sensitive data in reports.
