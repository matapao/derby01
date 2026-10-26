import { SFX } from './audio.ts';
import { requiredElement } from './browser-dom.ts';
import { createMusicPlayer, type PlayableTrack } from './music-player.ts';
import { createMusicLibrary, musicTrackFromFile, MUSIC_LIMITS, type Playlist } from './music-library.ts';
import {
  isRandomMusicQueue,
  randomMusicQueue,
  RADIO_PLAYLISTS,
  musicCredit,
  recordingCredit,
  readMusicQueue,
  readRadioPlaylists,
  trackUrl,
  type RadioPlaylist,
  type MusicQueue,
} from './music-model.ts';
import { DEFAULT_SOUND, loadSoundSettings, SOUND_KEY, soundLevels } from './music-settings.ts';
import { connectRadio, type RadioState } from './music-bridge.ts';
import { roomMusic, setRoomMusic, subscribeRoomMusic } from './net/music-room.ts';
import { currentRole, subscribeRole } from './net/role.ts';

export function mountSoundControls(opening: () => void, picture: { get(): string; set(mode: string): void }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'utility-dialog sound-dialog';
  dialog.setAttribute('aria-labelledby', 'soundTitle');
  dialog.innerHTML = `<form method="dialog"><header><h2 id="soundTitle">Sound & picture</h2><button class="btn small" aria-label="Close sound controls">Close</button></header></form>
    <label>Picture <select data-picture><option value="auto">Auto · clear and adaptive</option><option value="performance">Older laptop · lower GPU load</option><option value="sharp">Sharp · more detail</option></select></label>
    <label>Listen to <select data-mode><option value="both">Game sound + music</option><option value="effects">Game sound only</option><option value="music">Music only</option><option value="muted">All sound off</option></select></label>
    <label>Game sound <output data-effects-value></output><input data-effects type="range" min="0" max="1" step="0.01" aria-label="Game sound volume"></label>
    <label>Music <output data-music-value></output><input data-music type="range" min="0" max="1" step="0.01" aria-label="Music volume"></label>
    <p class="utility-note">Balanced starting mix: 55% game sound · 22% music. Your levels stay independent.</p>
    <label>Music source <select data-source><option value="host">Follow host’s radio</option><option value="personal">My music</option></select></label>
    <label>Playlist <select data-playlist aria-label="Music playlist"></select></label>
    <div class="utility-actions"><button class="btn small" data-prev>Previous</button><button class="btn small" data-play>Play / retry</button><button class="btn small" data-next>Next</button></div>
    <button class="btn small" data-share>Use selected playlist for the room</button>
    <p data-status role="status">Radio starts with your first click.</p><p data-credit class="utility-note"></p>
    <label>Name for uploaded playlist <input data-name maxlength="100" value="My driving mix"></label>
    <label class="btn small">Add audio files<input data-files type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.flac,.opus" multiple></label>
    <div class="utility-actions"><button class="btn small" data-delete>Delete saved playlist</button><label class="btn small">Import radio playlist<input data-import type="file" accept="application/json,.json"></label></div>
    <p class="utility-note">Audio files stay in this browser on this device (up to 40 tracks, 20 MiB each; 200 MiB total). A room shares the song list, not your files: other players need the same recordings saved on their device. Clearing browser data removes saved music. Zirbel Radio lists load automatically when its player is available; exported Radio JSON also works here.</p>
    <p data-warning role="status"></p>`;
  document.body.append(dialog);
  const find = <T extends HTMLElement>(name: string, ctor: new () => T): T =>
    requiredElement(`[data-${name}]`, ctor, dialog);
  const mode = find('mode', HTMLSelectElement),
    effects = find('effects', HTMLInputElement),
    music = find('music', HTMLInputElement),
    source = find('source', HTMLSelectElement),
    station = find('playlist', HTMLSelectElement);
  const status = find('status', HTMLElement),
    warning = find('warning', HTMLElement),
    credit = find('credit', HTMLElement);
  const files = find('files', HTMLInputElement),
    importFile = find('import', HTMLInputElement),
    share = find('share', HTMLButtonElement);
  const pictureSelect = find('picture', HTMLSelectElement);
  pictureSelect.value = picture.get();
  pictureSelect.onchange = () => picture.set(pictureSelect.value);
  let settings = { ...DEFAULT_SOUND },
    library: ReturnType<typeof createMusicLibrary>,
    playlists: Playlist[] = [],
    imported: RadioPlaylist[] = [],
    radio: RadioState | null = null;
  let disposed = false,
    queueKey = '',
    busy = false,
    libraryVersion = 0;
  let hasSoundPreference = false;
  let waitingForRadio = true;
  let gestureAllowed = false;
  let radioTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    hasSoundPreference = localStorage.getItem(SOUND_KEY) !== null;
    settings = loadSoundSettings(localStorage);
  } catch {
    /* session preferences work without storage */
  }
  library = createMusicLibrary();
  const audio = document.createElement('audio');
  audio.preload = 'none';
  const player = createMusicPlayer(audio, (text) => {
    status.textContent = text;
  });
  const warn = (err: unknown) => {
    warning.textContent = err instanceof Error ? err.message : 'Could not save music on this device.';
  };
  function persist() {
    try {
      localStorage.setItem(SOUND_KEY, JSON.stringify(settings));
      localStorage.setItem('derby01:radio:lists', JSON.stringify(imported));
    } catch {
      warning.textContent = 'Sound works for this visit; browser storage could not save your settings.';
    }
  }
  function options(): RadioPlaylist[] {
    const external = (radio?.playlists ?? []).filter((playlist) => playlist.id !== 'host');
    return [
      ...RADIO_PLAYLISTS,
      ...external.filter((p) => !RADIO_PLAYLISTS.some((r) => r.id === p.id)),
      ...imported.filter((p) => !external.some((r) => r.id === p.id)),
      ...playlists.map((p) => ({ id: p.id, title: p.title, tracks: p.tracks.map((t) => t.id) })),
    ];
  }
  function selected(): MusicQueue {
    return options().find((p) => p.id === settings.playlist) ?? { title: 'Music unavailable', tracks: [] };
  }
  function activeQueue(): MusicQueue {
    const queue = settings.source === 'host' ? roomMusic() : selected();
    return readMusicQueue(queue) ?? { title: 'Music unavailable', tracks: [] };
  }
  function canUseRadio(queue: MusicQueue): boolean {
    return (
      !!radio &&
      queue.tracks.length > 0 &&
      queue.tracks.every((id) => !!musicCredit(id) || radio?.localTracks.some((track) => track.id === id))
    );
  }
  function renderCredit(queue: MusicQueue) {
    credit.replaceChildren();
    const creditedTracks = [...queue.tracks, ...(radio?.playing && radio.trackId ? [radio.trackId] : [])];
    for (const id of [...new Set(creditedTracks)]) {
      const item = document.createElement('span'),
        info = recordingCredit(id);
      if (info) {
        const link = document.createElement('a');
        link.href = info.source;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${info.title} — ${info.artist}`;
        const license = document.createElement('a');
        license.href = info.licenseUrl;
        license.target = '_blank';
        license.rel = 'noopener noreferrer';
        license.textContent = info.license;
        item.append(link, ' · ', license, ' · Unmodified recording. ');
      } else {
        const local =
          playlists.flatMap((p) => p.tracks).find((t) => t.id === id) ??
          radio?.localTracks.find((t) => t.id === id);
        item.textContent = local
          ? `${local.title} · Your device’s recording; creator/licence not supplied. `
          : 'Local recording needed on this device. ';
      }
      credit.append(item);
    }
    for (const cover of document.querySelectorAll('[data-music-credits]'))
      cover.replaceChildren(...[...credit.childNodes].map((n) => n.cloneNode(true)));
  }
  function render() {
    mode.value = settings.mode;
    source.value = settings.source;
    effects.value = String(settings.effects);
    music.value = String(settings.music);
    find('effects-value', HTMLOutputElement).value = `${Math.round(settings.effects * 100)}%`;
    find('music-value', HTMLOutputElement).value = `${Math.round(settings.music * 100)}%`;
    const value = settings.playlist;
    station.replaceChildren();
    for (const p of options()) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.title;
      station.append(option);
    }
    station.value = value;
    if (!station.value) station.selectedIndex = -1;
    share.disabled = currentRole() === 'replica';
    share.textContent =
      currentRole() === 'replica'
        ? 'The host chooses the room playlist'
        : 'Use selected playlist for the room';
    renderCredit(activeQueue());
  }
  function applyMix() {
    const levels = soundLevels(settings);
    SFX.setVolume(levels.effects);
    const useParent = canUseRadio(activeQueue());
    player.setLevel(useParent || !gestureAllowed ? 0 : levels.music);
    if (radio) {
      if (!useParent) bridge?.send({ action: 'pause' });
      bridge?.send({ action: 'volume', value: levels.music });
      bridge?.send({ action: 'mute', value: !useParent || levels.music === 0 });
      if (gestureAllowed && useParent && levels.music > 0) bridge?.send({ action: 'play' });
    }
    if (levels.music === 0) status.textContent = 'Music is off. Your music volume is remembered.';
  }
  function loadQueue() {
    if (disposed) return;
    if (!gestureAllowed) {
      status.textContent = 'Music starts after your first click.';
      return;
    }
    if (!radio && waitingForRadio) {
      status.textContent = 'Connecting to Zirbel Radio…';
      return;
    }
    const queue = activeQueue(),
      useParent = canUseRadio(queue);
    const key = JSON.stringify([queue, useParent, libraryVersion]);
    if (queueKey === key) {
      renderCredit(queue);
      return;
    }
    queueKey = key;
    if (useParent) {
      player.setQueue([]);
      if (isRandomMusicQueue(queue) && settings.playlist === 'random')
        bridge?.send({ action: 'playlist', value: 'random' });
      else bridge?.send({ action: 'queue', value: queue });
      status.textContent = `Zirbel Radio · ${queue.title}`;
    } else {
      const localTracks = playlists.flatMap((p) => p.tracks);
      const tracks: PlayableTrack[] = [];
      const ordered =
        isRandomMusicQueue(queue) && settings.playlist === 'random' ? randomMusicQueue() : queue;
      for (const id of ordered.tracks) {
        const url = trackUrl(id),
          info = musicCredit(id),
          local = localTracks.find((t) => t.id === id);
        if (url && info) tracks.push({ id, title: info.title, url });
        else if (local)
          tracks.push({ id, title: local.title, url: URL.createObjectURL(local.blob), owned: true });
      }
      player.setQueue(tracks);
      if (tracks.length < queue.tracks.length)
        warning.textContent =
          'This playlist needs recordings saved on this device. Add the same audio files, or choose My music.';
    }
    applyMix();
    renderCredit(queue);
  }
  const bridge = connectRadio(window, (state) => {
    if (state.loading) {
      status.textContent = 'Loading saved Radio playlists…';
      return;
    }
    waitingForRadio = false;
    if (radioTimer !== null) {
      clearTimeout(radioTimer);
      radioTimer = null;
    }
    const initial = !radio;
    radio = state;
    if (
      initial &&
      !hasSoundPreference &&
      state.selected !== 'host' &&
      state.playlists.some((p) => p.id === state.selected)
    ) {
      settings.playlist = state.selected;
      settings.source = state.selected === 'random' ? 'host' : 'personal';
      persist();
    }
    render();
    loadQueue();
    if (initial) {
      warning.textContent = '';
      applyMix();
    }
    if (state.error) status.textContent = state.error;
    else if (state.playing)
      status.textContent = `Zirbel Radio · ${state.trackId ? (musicCredit(state.trackId)?.title ?? state.localTracks.find((t) => t.id === state.trackId)?.title ?? 'Playing') : 'Playing'}`;
  });
  if (bridge)
    radioTimer = setTimeout(() => {
      radioTimer = null;
      waitingForRadio = false;
      loadQueue();
      applyMix();
    }, 1500);
  else waitingForRadio = false;
  try {
    imported = readRadioPlaylists(
      JSON.parse(
        localStorage.getItem('derby01:radio:lists') ?? localStorage.getItem('zirbel:radio:v1') ?? 'null',
      ) as unknown,
    );
    const savedQueue = readMusicQueue(
      JSON.parse(localStorage.getItem('derby01:radio:room') ?? 'null') as unknown,
    );
    if (savedQueue) setRoomMusic(savedQueue);
  } catch {
    /* defaults */
  }
  const roomChange = subscribeRoomMusic(() => {
    render();
    loadQueue();
  });
  const roleChange = subscribeRole(() => {
    render();
    loadQueue();
  });
  async function refreshLibrary() {
    try {
      const saved = await library.list();
      if (disposed) return;
      playlists = saved;
      libraryVersion++;
      render();
      loadQueue();
    } catch (err) {
      if (!disposed) warn(err);
    }
  }
  const change = () => {
    settings = {
      ...settings,
      mode:
        mode.value === 'both' || mode.value === 'effects' || mode.value === 'music' ? mode.value : 'muted',
      effects: Number(effects.value),
      music: Number(music.value),
      source: source.value === 'personal' ? 'personal' : 'host',
      playlist: station.value || 'random',
    };
    persist();
    render();
    loadQueue();
    applyMix();
  };
  mode.onchange = change;
  effects.oninput = change;
  music.oninput = change;
  source.onchange = change;
  station.onchange = () => {
    source.value = 'personal';
    change();
  };
  share.onclick = () => {
    if (currentRole() === 'replica') return;
    const queue = selected();
    if (setRoomMusic(queue)) {
      settings.source = 'host';
      persist();
      try {
        localStorage.setItem('derby01:radio:room', JSON.stringify(queue));
      } catch {
        warn('Could not save room playlist.');
      }
      render();
      loadQueue();
    }
  };
  find('play', HTMLButtonElement).onclick = () => {
    gestureAllowed = true;
    loadQueue();
    applyMix();
    if (canUseRadio(activeQueue())) bridge?.send({ action: 'play' });
    else void player.play();
  };
  find('prev', HTMLButtonElement).onclick = () => {
    if (canUseRadio(activeQueue())) bridge?.send({ action: 'previous' });
    else player.skip(-1);
  };
  find('next', HTMLButtonElement).onclick = () => {
    if (canUseRadio(activeQueue())) bridge?.send({ action: 'next' });
    else player.skip();
  };
  files.onchange = () => {
    void (async () => {
      if (busy || !files.files?.length) return;
      busy = true;
      warning.textContent = 'Saving audio on this device…';
      try {
        if (files.files.length > MUSIC_LIMITS.tracksPerPlaylist)
          throw new Error('Choose 40 recordings or fewer.');
        const tracks = [];
        for (const file of files.files) tracks.push(await musicTrackFromFile(file));
        if (disposed) return;
        const playlist: Playlist = {
          id: `device-${crypto.randomUUID()}`,
          title: find('name', HTMLInputElement).value.trim() || 'My driving mix',
          tracks,
        };
        if (radio && bridge) await bridge.request({ action: 'upload', value: playlist });
        else await library.save(playlist);
        if (disposed) return;
        settings.playlist = playlist.id;
        settings.source = 'personal';
        persist();
        if (radio) {
          render();
          loadQueue();
        } else await refreshLibrary();
        warning.textContent = 'Playlist saved on this device.';
      } catch (err) {
        warn(err);
      } finally {
        busy = false;
        files.value = '';
      }
    })();
  };
  find('delete', HTMLButtonElement).onclick = () => {
    void (async () => {
      const local = playlists.find((p) => p.id === settings.playlist);
      if (radio?.playlists.some((p) => p.id === settings.playlist && p.id.startsWith('device-')) && bridge) {
        try {
          await bridge.request({ action: 'deletePlaylist', value: settings.playlist });
          settings.playlist = 'random';
          persist();
          render();
          loadQueue();
        } catch (err) {
          warn(err);
        }
      } else if (local) {
        try {
          await library.remove(local.id);
          settings.playlist = 'random';
          persist();
          await refreshLibrary();
        } catch (err) {
          warn(err);
        }
      } else if (imported.some((p) => p.id === settings.playlist)) {
        imported = imported.filter((p) => p.id !== settings.playlist);
        settings.playlist = 'random';
        persist();
        render();
        loadQueue();
      } else warning.textContent = 'Choose one of your saved playlists to delete it.';
    })();
  };
  importFile.onchange = () => {
    void (async () => {
      try {
        const file = importFile.files?.[0];
        if (!file) return;
        if (file.size > 65536) throw new Error('Radio playlist JSON must be 64 KiB or smaller.');
        const raw: unknown = JSON.parse(await file.text());
        if (disposed) return;
        let lists = readRadioPlaylists(raw);
        if (!lists.length && raw && typeof raw === 'object' && 'radio' in raw) {
          const queue = readMusicQueue({ title: 'Imported Radio playlist', tracks: raw.radio });
          if (queue && queue.tracks.every((id) => !!musicCredit(id)))
            lists = [{ id: `personal-${crypto.randomUUID()}`, ...queue }];
        }
        if (!lists.length)
          throw new Error('No compatible Zirbel Radio playlist found. Export a playlist from Radio.');
        imported = [...imported.filter((p) => !lists.some((q) => q.id === p.id)), ...lists].slice(-30);
        settings.playlist = lists[0]?.id ?? 'random';
        settings.source = 'personal';
        persist();
        render();
        loadQueue();
        warning.textContent = 'Radio playlist imported.';
      } catch (err) {
        warn(err);
      } finally {
        importFile.value = '';
      }
    })();
  };
  const gesture = (event: Event) => {
    if (disposed || !event.isTrusted) return;
    gestureAllowed = true;
    loadQueue();
    applyMix();
    void player.play();
    if (canUseRadio(activeQueue()) && !radio?.playing && !radio?.muted && soundLevels(settings).music > 0)
      bridge?.send({ action: 'play' });
  };
  window.addEventListener('pointerdown', gesture, { passive: true });
  window.addEventListener('keydown', gesture, { passive: true });
  for (const event of ['keydown', 'keyup', 'pointerdown', 'pointerup'])
    dialog.addEventListener(event, (e) => e.stopPropagation());
  const open = () => {
    gestureAllowed = navigator.userActivation?.isActive === true || gestureAllowed;
    opening();
    SFX.init();
    if (!dialog.open) dialog.showModal();
  };
  render();
  loadQueue();
  applyMix();
  void refreshLibrary();
  return {
    open,
    destroy() {
      if (disposed) return;
      disposed = true;
      if (radioTimer !== null) clearTimeout(radioTimer);
      window.removeEventListener('pointerdown', gesture);
      window.removeEventListener('keydown', gesture);
      roomChange();
      roleChange();
      bridge?.destroy();
      player.destroy();
      library.close();
      dialog.remove();
    },
  };
}
