# derby01

A paintball demolition derby for the browser, in TypeScript and three.js, with clear stylized
graphics. Two to eight cars, four seats each: a driver, a mechanic and two gunners on the hood and
trunk turrets. Each player picks a car and a seat (keyboard, mouse, gamepads or touch, split screen; a new
player gets a car of their own); the CPU fills the rest. On a zirbel host, other screens join online.

- **The town** is laid out from a map number (_New map_ rolls another; `?map=123` opens one): three
  blocks each way with a ring road and two-lane streets, round an open square with the office and its
  concrete deck. It is sized to the number of cars.
- **The cars** each drive their own way: stock, rally, drift, sport, muscle. Pick one per car on the setup screen.
- **Nitro** gives a burst of speed, with a flame out of the exhaust.
- **Points**: damage you do, wrecks (+250), the roof radar as the headshot (+150), held drifts and
  donuts, last car standing (+200).
- **Mechanics** fix tyres, fuel, fires, glass and jammed guns in small games on the dashboard screens.
- **Data for everything you tune** (`data/`, listed in `zirbel.build.json`): the town as a layout of
  pieces, the piece catalogue and prefabs, the kits, the car, guns, damage, points, the mechanic's
  jobs, supply drops, bots, physics, rounds, controls, team colours and the town generator's recipe.
  Each block has a JSON Schema. A zirbel host can give a room a newer revision of the data; every
  screen loads it before the next round.
- **For agents** (`src/agent`): `play.ts` lets an agent take a seat as an ordinary player, `look.ts`
  draws the town as a plan, `check.ts` checks a data change before it is played.

## Controls

| Device           | Driver                                                             | Gunner                       | Mechanic                              |
| ---------------- | ------------------------------------------------------------------ | ---------------------------- | ------------------------------------- |
| Keyboard + mouse | WASD, Space handbrake, Shift nitro                                 | mouse aim, click fire        | W/S pick, Space start                 |
| Keys: arrows     | arrows, Enter handbrake, right Shift nitro                         | arrows aim, Enter fire       | ↑/↓ pick, Enter start                 |
| Gamepad          | left stick, RT gas, LT brake, X nitro                              | right stick aim, RT fire     | stick pick, A start                   |
| Touch            | left thumb steers, gas / brake / nitro / handbrake under the right | drag to aim, hold FIRE, ZOOM | tap a job twice, then work the screen |

C (Y on a gamepad, SEAT on a touch screen) changes seat, Esc (Start, ❚❚) pauses. The setup screen lists every
binding. Phones and tablets play by touch (picked by themselves; the last device used wins), in every seat,
and go full screen where the browser lets them.

## First visit and picture

The first visit shows four short seat views, each with responsibilities, device controls and point scoring.
Skip or finish remembers the current guide version; **How to play** opens it again. **Sound & picture**
offers Auto (adaptive detail), Older laptop (650,000-pixel budget) and Sharp (1.5-million-pixel budget).
All modes cap device pixel ratio at one. Auto starts at one million pixels, reduces sustained GPU load,
and restores detail after sustained headroom; it does not permanently blur the rest of a session.

## Breakaway bodywork

Substantial crashes loosen the struck doors, hood or trunk before the car is wrecked. Loose doors
hang and swing on their hinges; the hood and trunk flap while the car moves. A later substantial
impact can tear them off after a short loose stage. Light bumps and paintballs keep the panels attached.
A hard corner impact can pull off an already
damaged wheel; mechanics see the same missing wheel as the driver. Detached panels reveal seats,
floor, engine and chassis, while the remote turrets stay attached to the car.

Mechanics can tighten an attached loose panel with a short direction-and-tap job. A successful repair
closes the panel, clears its wear and earns one completed job toward the mechanics championship
(10 points). If another crash tears the panel off during the job, the job cancels without a reward;
tightening cannot replace a missing door or lid.
Online, the job waits for the host to confirm the panel is secure before showing it as fixed.

The interior uses three shared low-polygon meshes per car. Loose panels move their existing meshes
without separate physics bodies. Each collision releases at most one panel
and one wheel; wrecks release up to four remaining panels and two wheels. Debris expires, and Older
laptop mode retains its 650,000-pixel budget.

After `npm run zirbel`, run `node test/live/body-damage.ts` for the actual Chrome/WebGL host and
replica scenario. It needs the public Zirbel hub installed in an adjacent `zirbel.gg` checkout
(or `ZIRBEL=path`; the archived platform installation currently lives in `zirbel-old`). It checks
all six loose panels, visible door/hood motion, progressive detachment, turret anchoring, wheel/detail agreement,
actual replica keyboard tightening, cancelled jobs and championship accounting,
seat/pause/menu controls, and fresh intact cars after host takeover and restart. Proof images go
to the reported temporary folder, or `ARTIFACT_DIR` when set. This checks resource bounds and
cleanup; it does not benchmark frame rate on an older laptop.

## Sound and radio

Choose game sound plus music, game sound only, music only, or mute. The starting mix is 55% game sound
and 22% music; each slider remembers its own level when the mode changes. Real paintball-marker audio
replaces the shot effect; the engine retains RPM/gear response with a deeper pulse and exhaust sound.
Recording credits and licences remain visible under the title and alongside their asset files.

Zirbel Radio starts random reviewed CC0 music after a player gesture; saved playlists remain available. The standalone
game packages the same credited recording and can import Radio’s playlist export. Hosts choose the room’s
song list; each listener can follow it or select personal music and control their own volume.
Uploaded audio is saved on the current browser/device, never sent with room messages. Other listeners need
the same local recordings; matching uses content hashes, not filenames. IndexedDB limits are 20 playlists,
40 tracks per playlist, 20 MiB per track and 200 MiB total. Storage errors are shown, and clearing browser
data removes saved uploads. In hosted play, the trusted platform player owns this storage outside the game.

## Round reports and championships

**Standings** shows the last completed round, team results and each participant’s measured contributions.
The separate mechanics championship awards 10 points per completed job, 0.1 per restored system point and
0.05 per fuel unit actually delivered. Constructors collect place points (25/18/15/12/10/8/6/4) and wins
across rounds in a match; starting a new match resets championship standings.

The report measures hits/shots, accuracy, peak speed, travel distance, survival, longest continuous burn,
jobs, repairs, fuel and supported mechanic action precision. Precision counts accepted timing/direction
attempts; continuous games and unobservable remote actions show no precision result. The anonymous board
retains ten completed numeric scores per metric. Accuracy needs ten shots; precision needs five measured
attempts. Named reports stay within the game; stored and published aggregate records contain no player,
team, room, instance or date fields. Local records aggregate rounds on this device; an online host also
publishes supported numeric records through Zirbel’s metric channel when platform reporting is enabled.
