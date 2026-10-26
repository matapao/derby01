export interface PlayableTrack {
  id: string;
  title: string;
  url: string;
  owned?: boolean;
}
export interface MusicMedia extends EventTarget {
  src: string;
  volume: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}
/** One local music voice. Never starts from import; stale play promises cannot revive a muted queue. */
export function createMusicPlayer(
  media: MusicMedia,
  status: (message: string) => void,
  revoke: (url: string) => void = URL.revokeObjectURL,
) {
  let tracks: PlayableTrack[] = [],
    index = 0,
    enabled = false,
    destroyed = false;
  let generation = 0,
    pending = false,
    failed = new Set<string>();
  function current(): PlayableTrack | undefined {
    return tracks[index];
  }
  function release() {
    for (const track of tracks) if (track.owned) revoke(track.url);
  }
  function select() {
    generation++;
    pending = false;
    media.pause();
    const track = current();
    if (track) {
      media.src = track.url;
      media.load();
      status(`Ready · ${track.title}`);
    } else {
      media.removeAttribute('src');
      media.load();
      status('Choose music to listen.');
    }
  }
  async function play() {
    if (destroyed || !enabled || pending || !current() || !media.paused) return;
    const version = generation;
    pending = true;
    try {
      await media.play();
      if (destroyed || !enabled) media.pause();
      if (!destroyed && enabled && version === generation) status(`Playing · ${current()?.title ?? ''}`);
    } catch (err) {
      if (version === generation && enabled && !destroyed)
        status(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Press Play to start music.'
            : 'Music unavailable. Try Next or another playlist.',
        );
    } finally {
      if (version === generation) pending = false;
    }
  }
  function skip(direction = 1) {
    if (destroyed || !tracks.length) return;
    index = (index + direction + tracks.length) % tracks.length;
    select();
    void play();
  }
  const ended = () => skip();
  const error = () => {
    const track = current();
    if (!track || destroyed) return;
    failed.add(track.id);
    if (tracks.every((track) => failed.has(track.id))) {
      media.pause();
      status('Music unavailable. Choose another playlist or press Play to retry.');
      return;
    }
    skip();
  };
  media.addEventListener('ended', ended);
  media.addEventListener('error', error);
  return {
    setQueue(value: PlayableTrack[]) {
      if (destroyed) {
        for (const track of value) if (track.owned) revoke(track.url);
        return;
      }
      media.pause();
      release();
      tracks = value.slice(0, 40);
      for (const track of value.slice(40)) if (track.owned) revoke(track.url);
      index = 0;
      failed = new Set();
      select();
      void play();
    },
    setLevel(level: number) {
      if (destroyed) return;
      media.volume = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
      enabled = media.volume > 0;
      if (!enabled) {
        generation++;
        pending = false;
        media.pause();
      } else void play();
    },
    play() {
      failed.clear();
      return play();
    },
    skip,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      media.pause();
      release();
      tracks = [];
      media.removeEventListener('ended', ended);
      media.removeEventListener('error', error);
      media.removeAttribute('src');
      media.load();
    },
  };
}
