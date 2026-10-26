# Asset licence audit

Reviewed 2026-10-26. This source retains redistributable third-party assets with their required
notices. The root MIT licence covers owned code; it does not replace the car, font or audio licences.
Keep the adjacent notices, visible cover credits and modification records with redistributed copies.

## Car and font notices

The car files originate from [Bricchi Games' Retro Car With Interior](https://bricchi-games.itch.io/retro-car-with-interior):

| File under `assets/car/` |   Bytes | Recorded licence |
| ------------------------ | ------: | ---------------- |
| `Car.fbx`                | 142,844 | CC BY 4.0        |
| `car-paint-base.jpg`     | 334,611 | CC BY 4.0        |
| `car-paint-mask.png`     |  10,770 | CC BY 4.0        |
| `car-emissive.png`       |   4,065 | CC BY 4.0        |

The creator's page confirms attribution-required Creative Commons use; the exact 4.0 version is
recorded in [the retained notice](../assets/car/LICENSE.txt). Repacked textures remain derived assets.
The notice and visible cover identify the asset, creator, source, licence and modifications, covering
the credit, licence-link and change-notice requirements described by
[Creative Commons](https://creativecommons.org/licenses/by/4.0/). `src/core.ts` loads and clones the
FBX geometry; the runtime car is not wholly independent procedural artwork.

`Bungee-400.woff2` and `BarlowCondensed-500.woff2`, `-600.woff2`, `-700.woff2` retain SIL OFL 1.1.
See the creators' [Bungee](https://github.com/djrrb/Bungee/blob/master/OFL.txt) and
[Barlow](https://github.com/jpt/barlow/blob/main/OFL.txt) notices. Their adjacent OFL files preserve
the copyright and licence text. The cover credits identify both font projects and link to those notices.
These fonts remain OFL when bundled with MIT application code.

## Remaining material

| Material                           | Licence and evidence                                                          | Scope                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Owned application, rules and tools | Root MIT, Matapao copyright                                                   | Declared ownership; independent authorship is not established by a licence notice alone |
| 56 procedural catalogue entries    | MIT, Matapao; named source modules                                            | Primitive meshes/materials; the complete car still incorporates the CC BY model         |
| Installed paintball effect         | [Creator-confirmed CC0](https://freesound.org/people/fabianofa/sounds/98189/) | One 13,359-byte MP3; hash matches adjacent provenance                                   |
| Five optional music entries        | Creator-confirmed CC0; links below                                            | Runtime downloads; no recordings bundled                                                |
| Zirbel net SDK and SHA256 fallback | MIT; adjacent notices and source provenance                                   | Vendored source/compiled hash owner                                                     |
| Zirbel engineering archive         | MIT; declared package licence and matching upstream implementation            | Adjacent upstream notice; no bundled assets or dependencies                             |
| three.js                           | MIT; installed notice copied into builds                                      | npm runtime dependency; excluded from source snapshot                                   |

The engineering archive contains only `browser.js`, `browser.d.ts`, `package.json` and `README.md`.
Retain [vendor notices and provenance](../vendor/README.md).

Optional music sources reviewed as CC0:
[Lofi Hip Hop Loop](https://opengameart.org/content/lofi-hip-hop-loop),
[Heavenly Loop](https://opengameart.org/content/heavenly-loop),
[relax_background1](https://opengameart.org/content/relaxbackground1-0),
[Simple Action Beat](https://opengameart.org/content/simple-action-beat),
[Covert Action](https://opengameart.org/content/covert-action).

`assets/audio/selection.json` lists five uninstalled Pixabay candidates; their recordings are absent.
`radio/today.json` and `CREDITS.txt` retain the withdrawn music record without its bytes.
The music model uses the withdrawal hash to reject that recording, so removing metadata requires
preserving that rejection behavior.

## Inventory and verification limits

MIME inspection of every copied source file found exactly eleven nontext files: one MP3, one FBX,
one JPEG, three PNGs (including the README cartridge), four WOFF2s and one archive. No additional models, spritesheets, prototype
archives, backups or recordings were copied. Source contains one embedded blank 1×1 PNG placeholder;
its separate creator is undocumented. No substantive artwork was identified in it.

Installed dependencies and generated builds are excluded. The toolchain itself includes Apache-2.0,
ISC and BSD dependencies as well as MIT packages; their original notices remain applicable.

Fresh Node 24.22.1 installation and verification passed four strict profiles, formatting, 240 tests
and both builds. Dependency audit reported zero vulnerabilities. A fully redacted archive-depth-2
credential scan found only the reviewed `RECORD_KEY` storage-namespace false positive in
`src/competition.ts`; no finding was suppressed. These checks do not establish asset ownership or
complete browser/device coverage.

## README logo

`docs/cartridge.png` reuses the actual cartridge from [Zirbel](https://zirbel.app/), exported
from its existing front-face markup, styles and painted key art. The cartridge and README carry
no status label. The README displays the cartridge at 112 pixels wide.
The cartridge layout is from Zirbel’s `packages/web/lib/cover.ts` and site styles; retain
[its MIT notice](ZIRBEL_CARTRIDGE_LICENSE.txt). The image includes rendered lettering, not font
software; the SIL OFL does not require documents or artwork produced with a font to use OFL.
The pictured car incorporates Bricchi Games’ CC BY 4.0 model and derived textures; retain `assets/car/LICENSE.txt` and its creator/source/modification credits.
