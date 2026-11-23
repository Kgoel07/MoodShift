import { LyricsSession } from './lyrics-session';
import { activeLyric, playbackKey, validSong, youtubePlaybackPort, type LyricLine, type LyricsCancel, type LyricsRequest,
  type LyricsResult, type PlayerPlayback } from './shared/lyrics';
import type { CaptureSession } from './shared/types';
import type { AudioTiming } from './shared/tuning';
import { installMediaSessionBridge } from './media-session-bridge';
import { calibratedLyricsPosition, PlaybackTimeline } from './playout-timing';
import { clampLyricsCorrection } from './shared/display-settings';
import { observeDisplay, setDisplay } from './display-client';
import { canUseCaptions, currentCaptions } from './player-captions';

const correctionKey = 'lyricsCorrections';
type Correction = { title: string; artist: string };
const now = () => performance.timeOrigin + performance.now();

export function mountLyrics(root: HTMLElement, onPlayback: (playback: PlayerPlayback | null, offset: number) => void) {
  const form = root.querySelector<HTMLFormElement>('#lyrics-search')!;
  const options = root.querySelector<HTMLDetailsElement>('#lyric-options')!;
  const details = root as HTMLDetailsElement;
  const title = root.querySelector<HTMLInputElement>('#lyrics-title')!;
  const artist = root.querySelector<HTMLInputElement>('#lyrics-artist')!;
  const search = root.querySelector<HTMLButtonElement>('#lyrics-submit')!;
  const status = root.querySelector<HTMLParagraphElement>('#lyrics-status')!;
  const viewport = root.querySelector<HTMLDivElement>('#lyrics-viewport')!;
  const follow = root.querySelector<HTMLInputElement>('#lyrics-follow')!;
  const offset = root.querySelector<HTMLInputElement>('#lyrics-offset')!;
  const session = new LyricsSession();
  const timeline = new PlaybackTimeline();

  let source: CaptureSession | undefined;
  let connection: chrome.runtime.Port | undefined;
  let connecting: string | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let edited = false;
  let editing = false;
  let allowSearchAt = 0;
  let lines: LyricLine[] = [];
  let lineElements: HTMLParagraphElement[] = [];
  let active = -1;
  let timing: AudioTiming | undefined;
  let captionFallback: string | undefined;
  let activeLookup: string | undefined;

  function refreshControls(): void {
    form.hidden = session.playback === null;
    options.hidden = form.hidden;
    search.disabled = !session.playback?.song.duration || Date.now() < allowSearchAt;
  }

  function clearLyrics(): void {
    if (captionFallback) requestCaptions(false);
    captionFallback = undefined;
    active = -1;
    lines = [];
    lineElements = [];
    viewport.replaceChildren();
    viewport.hidden = true;
    viewport.setAttribute('aria-label', 'Song lyrics');
    follow.disabled = true;
  }

  function requestCaptions(enabled: boolean): void {
    try { connection?.postMessage({ type: 'captions', enabled }); } catch { /* The player navigated. */ }
  }

  function cancelLookup(): void {
    if (!activeLookup) return;
    void chrome.runtime.sendMessage({ target: 'lyrics', cancel: activeLookup } satisfies LyricsCancel).catch(() => undefined);
    activeLookup = undefined;
  }

  function centerActive(): void {
    if (!follow.checked || !viewport.clientHeight) return;
    const line = lineElements[active];
    if (line?.hidden) return;
    viewport.scrollTop = line ? line.offsetTop - (viewport.clientHeight - line.clientHeight) / 2 : 0;
  }

  new ResizeObserver(centerActive).observe(viewport);

  function highlight(): void {
    const playback = session.playback;
    const correction = clampLyricsCorrection(offset.valueAsNumber);
    if (!playback) {
      onPlayback(null, 0);
      return;
    }
    const automatic = timing?.playoutSeconds ?? 0;
    const basePosition = timeline.position(playback, now(), automatic);
    const aligned = { ...playback, position: calibratedLyricsPosition(playback, basePosition, correction) };
    onPlayback(aligned, 0);
    if (captionFallback) {
      const caption = currentCaptions(playback.captions ?? [], aligned.position);
      const available = !!playback.captions?.length;
      const captionStatus = available ? 'Page captions' : captionFallback;
      if (status.textContent !== captionStatus) status.textContent = captionStatus;
      viewport.setAttribute('aria-label', 'Page captions');
      if (viewport.textContent !== caption) viewport.textContent = caption;
      viewport.hidden = !caption;
    }
    if (!lines.length) return;
    const index = activeLyric(lines, aligned, 0);
    if (index === active) return;
    lineElements[active]?.removeAttribute('aria-current');
    active = index;
    if (lines[index]?.text) lineElements[index].setAttribute('aria-current', 'true');
    centerActive();
  }

  function show(result: LyricsResult): void {
    clearLyrics();
    switch (result.kind) {
      case 'synced':
        status.textContent = 'Synchronized lyrics';
        lines = result.lines;
        lineElements = lines.map(({ text }) => {
          const line = document.createElement('p');
          line.textContent = text;
          line.hidden = !text;
          return line;
        });
        viewport.replaceChildren(...lineElements);
        viewport.hidden = false;
        follow.disabled = false;
        highlight();
        break;
      case 'plain': {
        status.textContent = 'Plain lyrics · Timing unavailable';
        const plain = document.createElement('p');
        plain.textContent = result.text;
        viewport.replaceChildren(plain);
        viewport.hidden = false;
        break;
      }
      case 'instrumental': status.textContent = 'This track is listed as instrumental.'; break;
      case 'invalid': status.textContent = 'Lyrics unavailable · Enter the title and artist to search.'; break;
      case 'missing': status.textContent = 'Lyrics unavailable · No matching recording found.'; break;
      case 'ambiguous': status.textContent = 'Multiple recordings match. Check the song details.'; break;
      case 'error': status.textContent = 'Could not load lyrics. Try again shortly.'; break;
      case 'limited': {
        allowSearchAt = result.retryAt;
        const wait = Math.max(1000, Math.ceil(allowSearchAt - Date.now()));
        const notice = 'Please wait a moment before searching again.';
        status.textContent = notice;
        clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
          if (status.textContent === notice && Date.now() >= allowSearchAt) status.textContent = 'You can retry the lyric search.';
          refreshControls();
        }, Math.min(2_147_483_647, wait));
        break;
      }
    }
    if (canUseCaptions(result)) {
      captionFallback = status.textContent;
      requestCaptions(true);
      highlight();
    }
    refreshControls();
  }

  async function find(revision: number, retry: boolean): Promise<void> {
    if (!session.acceptsLookup(revision)) return;
    cancelLookup();
    const { album, duration } = session.playback!.song;
    const query = { title: title.value.trim(), artist: artist.value.trim(), duration, album: edited ? undefined : album };
    if (!validSong(query)) {
      show({ kind: 'invalid' });
      return;
    }
    clearLyrics();
    status.textContent = 'Finding lyrics…';
    const requestId = activeLookup = crypto.randomUUID();
    try {
      const result: LyricsResult = await chrome.runtime.sendMessage({
        target: 'lyrics', query, retry, requestId,
      } satisfies LyricsRequest);
      if (session.acceptsLookup(revision)) show(result);
    } catch {
      if (session.acceptsLookup(revision)) show({ kind: 'error' });
    } finally {
      if (activeLookup === requestId) activeLookup = undefined;
    }
  }

  function receive(id: string, update: PlayerPlayback | null): void {
    const previousTrack = playbackKey(session.playback);
    const outcome = session.receive(id, update);
    if (outcome === 'ignored') return;
    if (update && !update.ad) timeline.sample(update, now());
    if (outcome === 'playback' && update) {
      highlight();
      return;
    }
    clearTimeout(searchTimer);
    cancelLookup();
    clearLyrics();
    refreshControls();
    highlight();
    if (!update) {
      title.value = '';
      artist.value = '';
      status.textContent = 'Waiting for a player on the selected tab…';
      return;
    }

    const track = playbackKey(update)!;
    if (previousTrack !== track) {
      edited = false;
      editing = false;
    }
    if (editing) return;
    if (!edited) {
      title.value = update.song.title.slice(0, 200);
      artist.value = update.song.artist.slice(0, 200);
    }
    if (!update.song.duration) {
      status.textContent = update.ad ? 'Lyrics will resume after the ad.' : 'Lyrics will appear when the track starts.';
      return;
    }
    status.textContent = 'Finding lyrics…';
    const revision = session.invalidateLookup();
    searchTimer = setTimeout(async () => {
      try {
        const stored = await chrome.storage.session.get(correctionKey);
        const corrections = stored[correctionKey] as Record<string, Correction> | undefined;
        const correction = corrections?.[track];
        if (!session.acceptsLookup(revision)) return;
        if (correction && !edited) {
          title.value = correction.title;
          artist.value = correction.artist;
          edited = true;
        }
      } catch {
        // Storage is optional for current playback.
      }
      void find(revision, false);
    }, 700);
  }

  async function connect(): Promise<void> {
    if (!source || connection || connecting) return;
    const { id, tabId } = source;
    connecting = id;
    const target = { tabId, frameIds: [0] };
    await Promise.allSettled([
      chrome.scripting.executeScript({ target, func: installMediaSessionBridge, world: 'MAIN' }),
      chrome.scripting.executeScript({ target, files: ['youtube-playback.js'] }),
    ]);
    if (connecting !== id || source?.id !== id) return;
    connecting = undefined;
    const port = chrome.tabs.connect(tabId, { name: youtubePlaybackPort, frameId: 0 });
    connection = port;
    port.onMessage.addListener((update: PlayerPlayback | null) => {
      if (connection === port) receive(id, update);
    });
    port.onDisconnect.addListener(() => {
      const failed = chrome.runtime.lastError;
      if (connection !== port) return;
      connection = undefined;
      receive(id, null);
      if (failed) status.textContent = 'Click MoodShift on the playing tab to look for lyrics.';
    });
  }

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === source?.tabId && change.status === 'complete') void connect();
  });

  for (const input of [title, artist]) {
    input.addEventListener('input', () => {
      edited = true;
      editing = true;
      clearTimeout(searchTimer);
      cancelLookup();
      session.invalidateLookup();
      clearLyrics();
      status.textContent = 'Search to apply your song details.';
    });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const playback = session.playback;
    if (!playback || search.disabled) return;
    clearTimeout(searchTimer);
    const revision = session.invalidateLookup();
    editing = false;
    const correction = { title: title.value.trim(), artist: artist.value.trim() };
    if (validSong({ ...correction, duration: playback.song.duration })) {
      edited = true;
      void chrome.storage.session.get(correctionKey).then(values => {
        const track = playbackKey(playback)!;
        const entries = Object.entries(values[correctionKey] ?? {}).filter(([id]) => id !== track);
        return chrome.storage.session.set({
          [correctionKey]: Object.fromEntries([...entries.slice(-11), [track, correction]]),
        });
      }).catch(() => undefined);
    }
    void find(revision, true);
  });

  let savedOffset: number | undefined;
  let displayReady = false;
  observeDisplay(preference => {
    if (savedOffset !== preference.lyricsOffset) offset.value = String(preference.lyricsOffset);
    savedOffset = preference.lyricsOffset;
    follow.checked = preference.lyricsFollow;
    details.open = preference.lyricsOpen;
    displayReady = true;
    highlight();
    centerActive();
  });
  offset.addEventListener('input', highlight);
  offset.addEventListener('change', () => {
    const value = clampLyricsCorrection(offset.valueAsNumber);
    offset.value = String(value);
    void setDisplay('lyrics.offset', value).catch(() => undefined);
    highlight();
  });
  follow.addEventListener('change', () => {
    centerActive();
    void setDisplay('lyrics.follow', follow.checked).catch(() => undefined);
  });
  details.addEventListener('toggle', () => {
    if (displayReady) void setDisplay('lyrics.open', details.open).catch(() => undefined);
  });
  function pauseFollow(): void {
    if (!follow.checked || follow.disabled) return;
    follow.checked = false;
    void setDisplay('lyrics.follow', false).catch(() => undefined);
  }
  for (const event of ['wheel', 'touchstart']) {
    viewport.addEventListener(event, pauseFollow, { passive: true });
  }
  viewport.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) pauseFollow();
  });

  return {
    setTiming(next?: AudioTiming): void {
      if (timing?.playoutSeconds === next?.playoutSeconds) return;
      timing = next;
      highlight();
    },
    setSource(next?: CaptureSession): void {
      if (next?.id === source?.id) return;
      const old = connection;
      connection = undefined;
      connecting = undefined;
      old?.disconnect();
      source = next;
      session.setSource(next?.id);
      timeline.reset();
      highlight();
      clearTimeout(searchTimer);
      cancelLookup();
      clearLyrics();
      title.value = '';
      artist.value = '';
      refreshControls();
      status.textContent = next
        ? 'Waiting for a player on the selected tab…'
        : 'Select a playing tab with the MoodShift icon.';
      void connect();
    },
  };
}
