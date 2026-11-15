import { LyricsSession } from './lyrics-session';
import { activeLyric, validSong, youtubePlaybackPort, type LyricLine, type LyricsRequest,
  type LyricsResult, type YouTubePlayback } from './shared/lyrics';
import type { CaptureSession } from './shared/types';

const offsetKey = 'lyricsOffset';
const correctionKey = 'lyricsCorrections';
type Correction = { title: string; artist: string };

const formatOffset = (value: number) => Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0));

export function mountLyrics(root: HTMLElement, onPlayback: (playback: YouTubePlayback | null, offset: number) => void) {
  const form = root.querySelector<HTMLFormElement>('#lyrics-search')!;
  const title = root.querySelector<HTMLInputElement>('#lyrics-title')!;
  const artist = root.querySelector<HTMLInputElement>('#lyrics-artist')!;
  const search = root.querySelector<HTMLButtonElement>('#lyrics-submit')!;
  const status = root.querySelector<HTMLParagraphElement>('#lyrics-status')!;
  const viewport = root.querySelector<HTMLDivElement>('#lyrics-viewport')!;
  const follow = root.querySelector<HTMLInputElement>('#lyrics-follow')!;
  const offset = root.querySelector<HTMLInputElement>('#lyrics-offset')!;
  const session = new LyricsSession();

  let source: CaptureSession | undefined;
  let connection: chrome.runtime.Port | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let edited = false;
  let editing = false;
  let allowSearchAt = 0;
  let lines: LyricLine[] = [];
  let lineElements: HTMLParagraphElement[] = [];
  let active = -1;

  function refreshControls(): void {
    form.hidden = session.playback === null;
    search.disabled = !session.playback?.song.duration || Date.now() < allowSearchAt;
  }

  function clearLyrics(): void {
    active = -1;
    lines = [];
    lineElements = [];
    viewport.replaceChildren();
    viewport.hidden = true;
    follow.disabled = true;
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
    onPlayback(playback, formatOffset(offset.valueAsNumber));
    if (!playback || !lines.length) return;
    const index = activeLyric(lines, playback, formatOffset(offset.valueAsNumber));
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
      case 'instrumental': status.textContent = 'LRCLIB lists this recording as instrumental.'; break;
      case 'invalid': status.textContent = 'Check the song title and artist. A finite video duration is needed.'; break;
      case 'missing': status.textContent = 'No matching lyrics. Check the song title and artist and try again.'; break;
      case 'ambiguous': status.textContent = 'Multiple recordings matched. Check the title and artist.'; break;
      case 'error': status.textContent = 'Could not reach LRCLIB or read its reply. Try again shortly.'; break;
      case 'limited': {
        allowSearchAt = result.retryAt;
        const seconds = Math.max(1, Math.ceil((allowSearchAt - Date.now()) / 1000));
        const notice = 'LRCLIB asks us to wait. Try again in ' + seconds + ' s.';
        status.textContent = notice;
        clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
          if (status.textContent === notice && Date.now() >= allowSearchAt) status.textContent = 'You can retry the lyric search.';
          refreshControls();
        }, Math.min(2_147_483_647, seconds * 1000));
        break;
      }
    }
    refreshControls();
  }

  async function find(revision: number, retry: boolean): Promise<void> {
    if (!session.acceptsLookup(revision)) return;
    const query = { title: title.value.trim(), artist: artist.value.trim(), duration: session.playback!.song.duration };
    if (!validSong(query)) {
      show({ kind: 'invalid' });
      return;
    }
    clearLyrics();
    status.textContent = 'Finding lyrics…';
    try {
      const result: LyricsResult = await chrome.runtime.sendMessage({
        target: 'lyrics', query, retry,
      } satisfies LyricsRequest);
      if (session.acceptsLookup(revision)) show(result);
    } catch {
      if (session.acceptsLookup(revision)) show({ kind: 'error' });
    }
  }

  function receive(id: string, update: YouTubePlayback | null): void {
    const previousVideo = session.playback?.videoId;
    const outcome = session.receive(id, update);
    if (outcome === 'ignored') return;
    if (outcome === 'changed') onPlayback(update, formatOffset(offset.valueAsNumber));
    if (outcome === 'playback' && update) {
      highlight();
      return;
    }
    clearTimeout(searchTimer);
    clearLyrics();
    refreshControls();
    if (!update) {
      title.value = '';
      artist.value = '';
      status.textContent = 'Waiting for a YouTube video on the selected tab…';
      return;
    }

    if (previousVideo !== update.videoId) {
      edited = false;
      editing = false;
    }
    if (editing) return;
    if (!edited) {
      title.value = update.song.title.slice(0, 200);
      artist.value = update.song.artist.slice(0, 200);
    }
    if (!update.song.duration) {
      status.textContent = update.ad ? 'Lyrics will resume after the ad.' : 'Waiting for the video to start…';
      return;
    }
    status.textContent = 'Finding lyrics…';
    const revision = session.invalidateLookup();
    searchTimer = setTimeout(async () => {
      try {
        const stored = await chrome.storage.session.get(correctionKey);
        const corrections = stored[correctionKey] as Record<string, Correction> | undefined;
        const correction = corrections?.[update.videoId];
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

  function connect(): void {
    if (!source || connection) return;
    const { id, tabId } = source;
    const port = chrome.tabs.connect(tabId, { name: youtubePlaybackPort, frameId: 0 });
    connection = port;
    port.onMessage.addListener((update: YouTubePlayback | null) => {
      if (connection === port) receive(id, update);
    });
    port.onDisconnect.addListener(() => {
      const failed = chrome.runtime.lastError;
      if (connection !== port) return;
      connection = undefined;
      receive(id, null);
      if (failed) status.textContent = 'Select a YouTube watch tab. Reload the page if the extension was just installed.';
    });
  }

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === source?.tabId && change.status === 'complete') connect();
  });

  for (const input of [title, artist]) {
    input.addEventListener('input', () => {
      edited = true;
      editing = true;
      clearTimeout(searchTimer);
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
        const entries = Object.entries(values[correctionKey] ?? {}).filter(([id]) => id !== playback.videoId);
        return chrome.storage.session.set({
          [correctionKey]: Object.fromEntries([...entries.slice(-11), [playback.videoId, correction]]),
        });
      }).catch(() => undefined);
    }
    void find(revision, true);
  });

  let offsetChanged = false;
  void chrome.storage.local.get(offsetKey).then(values => {
    if (offsetChanged) return;
    offset.value = String(formatOffset(Number(values[offsetKey] ?? 0)));
    highlight();
  }).catch(() => undefined);
  offset.addEventListener('input', () => {
    offsetChanged = true;
    highlight();
  });
  offset.addEventListener('change', () => {
    const value = formatOffset(offset.valueAsNumber);
    offset.value = String(value);
    void chrome.storage.local.set({ [offsetKey]: value }).catch(() => undefined);
    highlight();
  });
  follow.addEventListener('change', centerActive);
  for (const event of ['wheel', 'touchstart']) {
    viewport.addEventListener(event, () => { follow.checked = false; }, { passive: true });
  }
  viewport.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) follow.checked = false;
  });

  return {
    setSource(next?: CaptureSession): void {
      if (next?.id === source?.id) return;
      const old = connection;
      connection = undefined;
      old?.disconnect();
      source = next;
      session.setSource(next?.id);
      onPlayback(null, formatOffset(offset.valueAsNumber));
      clearTimeout(searchTimer);
      clearLyrics();
      title.value = '';
      artist.value = '';
      refreshControls();
      status.textContent = next
        ? 'Waiting for a YouTube video on the selected tab…'
        : 'Select a playing YouTube tab with the MoodShift icon.';
      connect();
    },
  };
}
