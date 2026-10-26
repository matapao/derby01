import { createRoleTransitions, routeRoomMessage, whenActive } from './router.ts';
import type * as ZN from '/zirbel-net.js';
import { setRole, currentRole } from './role.ts';
import {} from './protocol.ts';
import { session, setSession, setPendingRevision, takeRevision } from './context.ts';
import { lifecycle } from '../lifecycle.ts';
import { G } from '../state.ts';
import { prefetchRevision, useRevision } from '../data.ts';
import {
  hostAsk,
  hostControls,
  hostLost,
  hostPeerJoined,
  hostPeerLeft,
  hostResend,
  hostStart,
  hostStop,
} from './host.ts';
import { replicaMessage, replicaResync, replicaStart, replicaStop, replicaLinkDown } from './replica.ts';
/**
 * derby01 on zirbel: connecting, who runs the game, and handing messages to the host's or the
 * replica's side. Without a zirbel host (the plain web build) startNet() leaves the game offline,
 * as it always was. zirbel-net comes from the host at run time (/zirbel-net.js); it isn't bundled.
 */
type ZirbelNet = typeof ZN;

// A newer revision of the game landed for this room. New code: this page reloads at the revision's
// address, keeping its seat. New data: read now, played from the next round (straight away on the
// setup screen); the other screens load what the host's round message names.
function onRevision(rev: ZN.Revision): void {
  if (rev.engine) {
    location.assign(rev.base + location.search);
    return;
  }
  if (!session) return;
  setPendingRevision(rev.id);
  const activeSession = session;
  void prefetchRevision(activeSession.net, rev.id).then(
    whenActive(
      () => session === activeSession,
      () => {
        if (currentRole() !== 'replica' && G.state === 'menu') {
          takeRevision();
          lifecycle().renderSetup();
        }
      },
    ),
  );
}

const status = (text: string): void => {
  const el = document.getElementById('netStatus');
  if (el) {
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
};

/** Connects when a zirbel host serves the game; resolves when this screen knows its part. */
export async function startNet(): Promise<void> {
  // A plain web build plays offline: it never asks the site for /zirbel-net.js (there, that could be anything).
  if (!__ZIRBEL__) return;
  let zn: ZirbelNet;
  try {
    zn = (await import('/zirbel-net.js')) as ZirbelNet;
  } catch {
    return; // no zirbel host: offline
  }
  const net = zn.connect({ ...zn.launchParams(), loopback: false });
  // Served by a zirbel host, so the room is there: give a slow link time rather than playing alone.
  // A page that reloads gets its seat back: that's "resume", not "open".
  status('Connecting…');
  const opened = await new Promise<boolean>((done) => {
    const t = setTimeout(() => done(false), 30000);
    const yes = (): void => {
      clearTimeout(t);
      done(true);
    };
    net.on('open', yes);
    net.on('resume', yes);
    net.on('close', () => {
      clearTimeout(t);
      done(false);
    });
  });
  status('');
  if (!opened) {
    net.close();
    return; // the room never answered: offline
  }
  setSession({ zn, net });
  const roles = createRoleTransitions({
    current: currentRole,
    set: setRole,
    hostStart,
    hostStop,
    hostLost,
    replicaStart,
    replicaStop,
    replicaUi: (on) => document.body.classList.toggle('replica', on),
    toMenu: () => lifecycle().toMenu(),
    clock: () => lifecycle().checkHiddenClock(),
  });
  const active = () => session?.net === net;

  // the data this room plays, read before this screen takes part (the round messages name it too)
  net.on('revision', whenActive(active, onRevision));
  if (net.revision?.id) {
    status("Loading the room's revision…");
    await useRevision(net, net.revision.id);
    status('');
    if (net.closed || !active()) {
      if (active()) {
        setSession(null);
        roles.disconnected();
      }
      return;
    }
  }
  // a later "open" means the old seat was lost and this is a new one: find out our part again
  net.on(
    'open',
    whenActive(active, () => {
      status('');
      roles.decide(net.isHost());
      if (currentRole() === 'replica') replicaResync();
    }),
  );
  net.on(
    'host',
    whenActive(active, () => roles.decide(net.isHost())),
  );
  net.on(
    'peer',
    whenActive(active, (id) => {
      if (currentRole() === 'host') hostPeerJoined(id);
    }),
  );
  net.on(
    'leave',
    whenActive(active, (id) => {
      if (currentRole() === 'host') hostPeerLeft(id);
    }),
  );
  net.on(
    'disconnect',
    whenActive(active, () => {
      status('Reconnecting…');
      if (currentRole() === 'replica') replicaLinkDown();
    }),
  );
  net.on(
    'resume',
    whenActive(active, () => {
      status('');
      // messages in flight when the link dropped may be lost: the host sends everything again, others ask for it
      if (currentRole() === 'host') hostResend();
      else if (currentRole() === 'replica') replicaResync();
    }),
  );
  // the hub ended the session (the room is full, or it stopped): this screen goes on alone
  net.on(
    'close',
    whenActive(active, (_code, message) => {
      status(message ? `Disconnected: ${message}` : 'Disconnected');
      setSession(null);
      roles.disconnected();
    }),
  );
  net.on(
    'message',
    whenActive(active, (from, type, r) => {
      routeRoomMessage(currentRole(), from, net.hostId, type, r, { hostControls, hostAsk, replicaMessage });
    }),
  );
  roles.decide(net.isHost());
}
