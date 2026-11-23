import { normalizeSongTitle, parseLrc, trackKey, validSong, type LyricsCancel, type LyricsRequest, type LyricsResult, type SongQuery } from './shared/lyrics';

type Available = Extract<LyricsResult, { kind: 'synced' | 'plain' }> | { kind: 'instrumental' };
interface Candidate {
  difference: number;
  album: string;
  lyrics: Available;
}

function editionRank(album: string): number {
  if (/\b(?:remaster(?:ed)?|deluxe|anniversary|reissue|expanded|compilation|greatest hits|live at)\b/.test(album)) return 2;
  if (/\boriginal (?:recording|release|mix|version)\b/.test(album)) return 0;
  return 1;
}

export function matchLyrics(payload: unknown, song: SongQuery): LyricsResult {
  if (!Array.isArray(payload)) return { kind: 'error' };
  const candidates: Candidate[] = [];
  const title = trackKey(normalizeSongTitle(song.title));
  const artist = trackKey(song.artist);
  for (const row of payload.slice(0, 20)) {
    if (!row || typeof row !== 'object' || typeof row.trackName !== 'string' || typeof row.artistName !== 'string'
      || typeof row.duration !== 'number' || !Number.isFinite(row.duration)) continue;
    const difference = Math.abs(row.duration - song.duration);
    if (difference > 2 || trackKey(normalizeSongTitle(row.trackName)) !== title || trackKey(row.artistName) !== artist) continue;

    const plain = typeof row.plainLyrics === 'string' && row.plainLyrics.length <= 32_000 ? row.plainLyrics.trim() : '';
    const timed = typeof row.syncedLyrics === 'string' && row.syncedLyrics.length <= 32_000
      ? parseLrc(row.syncedLyrics) : [];
    const reliableTiming = timed.some(line => line.text) && timed.length <= 1_500
      && timed.at(-1)!.time < song.duration + 2;
    const album = typeof row.albumName === 'string' ? trackKey(row.albumName) : '';
    if (row.instrumental === true) candidates.push({ difference, album, lyrics: { kind: 'instrumental' } });
    else if (reliableTiming) candidates.push({ difference, album, lyrics: { kind: 'synced', lines: timed } });
    else if (plain) candidates.push({ difference, album, lyrics: { kind: 'plain', text: plain } });
  }

  candidates.sort((left, right) => left.difference - right.difference);
  if (!candidates.length) return { kind: 'missing' };
  const album = trackKey(song.album ?? '');
  const sameAlbum = album ? candidates.filter(candidate => candidate.album === album) : [];
  const pool = sameAlbum.length ? sameAlbum : candidates;
  const close = pool.filter(candidate => candidate.difference <= pool[0].difference + 0.75);
  const withLyrics = close.filter(candidate => candidate.lyrics.kind !== 'instrumental');
  const available = withLyrics.length ? withLyrics : close;
  const bestRank = Math.min(...available.map(candidate => editionRank(candidate.album)));
  const best = available.filter(candidate => editionRank(candidate.album) === bestRank);
  const selected = best.find(candidate => candidate.lyrics.kind === 'synced') ?? best[0];
  const signature = (lyrics: Available) => lyrics.kind === 'instrumental' ? ''
    : trackKey(lyrics.kind === 'plain' ? lyrics.text : lyrics.lines.map(line => line.text).join(' '));
  for (const { lyrics, difference } of best) {
    if (lyrics.kind !== selected.lyrics.kind || Math.abs(difference - selected.difference) > 0.25) continue;
    if (signature(lyrics) !== signature(selected.lyrics)) return { kind: 'ambiguous' };
    if (lyrics.kind === 'synced' && selected.lyrics.kind === 'synced') {
      const reference = selected.lyrics.lines.filter(line => line.text);
      const other = lyrics.lines.filter(line => line.text);
      if (reference.length !== other.length || other.some((line, i) => Math.abs(line.time - reference[i].time) > 2)) {
        return { kind: 'ambiguous' };
      }
    }
  }
  return selected.lyrics;
}

interface CacheEntry {
  key: string;
  result: LyricsResult;
  expiry: number;
}

interface LookupState {
  cache: CacheEntry[];
  retryAt: number;
  lastFinished: number;
}

const storageKey = 'lyricsLookup';
const spacing = 350;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class LyricsLookup {
  private state?: Promise<LookupState>;
  private requests = new Map<string | AbortSignal, Promise<LyricsResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly client: string,
    private readonly storage?: chrome.storage.StorageArea,
  ) {}

  search(song: SongQuery, retry = false, signal?: AbortSignal): Promise<LyricsResult> {
    if (!validSong(song)) return Promise.resolve({ kind: 'invalid' });
    const key = JSON.stringify(['recording-v2', trackKey(normalizeSongTitle(song.title)), trackKey(song.artist),
      trackKey(song.album ?? ''), Math.round(song.duration * 10)]);
    const requestKey = signal ?? key;
    const pending = this.requests.get(requestKey);
    if (pending) return pending;
    if (this.requests.size >= 4) return Promise.resolve({ kind: 'error' });
    const request = this.tail.then(async () => {
      if (signal?.aborted) return { kind: 'error' } as const;
      this.state ??= this.storage?.get(storageKey).then(values => values[storageKey]).catch(() => undefined)
        .then(stored => (stored as LookupState | undefined) ?? this.empty()) ?? Promise.resolve(this.empty());
      const state = await this.state;
      const now = Date.now();
      state.cache = state.cache.filter(entry => entry.expiry > now);
      const cached = state.cache.find(entry => entry.key === key);
      if (cached && !retry) return cached.result;
      if (state.retryAt > now) return { kind: 'limited', retryAt: state.retryAt } as const;
      const delay = state.lastFinished + spacing - now;
      if (delay > 0) await pause(delay);
      if (signal?.aborted) return { kind: 'error' } as const;

      const result = await this.fetchLyrics(song, state, signal);
      state.lastFinished = Date.now();
      if (signal?.aborted) return { kind: 'error' } as const;
      if (result.kind !== 'limited' && result.kind !== 'error') {
        const lifetime = result.kind === 'synced' || result.kind === 'plain' ? 30 * 60_000 : 5 * 60_000;
        state.cache = [{ key, result, expiry: state.lastFinished + lifetime },
          ...state.cache.filter(entry => entry.key !== key)].slice(0, 12);
      }
      await this.storage?.set({ [storageKey]: state }).catch(() => undefined);
      return result;
    }).catch((): LyricsResult => ({ kind: 'error' })).finally(() => this.requests.delete(requestKey));
    this.tail = request;
    this.requests.set(requestKey, request);
    return request;
  }

  private empty(): LookupState {
    return { cache: [], retryAt: 0, lastFinished: 0 };
  }

  private async fetchLyrics(song: SongQuery, state: LookupState, signal?: AbortSignal): Promise<LyricsResult> {
    const endpoint = new URL('https://lrclib.net/api/search');
    endpoint.searchParams.set('track_name', normalizeSongTitle(song.title));
    endpoint.searchParams.set('artist_name', song.artist.trim());
    try {
      const timeout = AbortSignal.timeout(8000);
      const response = await this.fetcher(endpoint, {
        headers: { 'X-User-Agent': this.client, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const retryAfter = response.headers.get('Retry-After');
      if (response.status === 429 || (response.status === 503 && retryAfter)) {
        const now = Date.now();
        const ms = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - now;
        const wait = Number.isFinite(ms) ? Math.max(1000, ms) : 30_000;
        state.retryAt = now + wait * (1 + Math.random() * 0.25);
        return { kind: 'limited', retryAt: state.retryAt };
      }
      if (response.status === 404) return { kind: 'missing' };
      if (response.status === 400) return { kind: 'invalid' };
      if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return { kind: 'error' };
      return matchLyrics(await response.json(), song);
    } catch {
      return { kind: 'error' };
    }
  }
}

export function installLyricsLookup(): void {
  const lookup = new LyricsLookup(fetch.bind(globalThis),
    'MoodShift/' + chrome.runtime.getManifest().version + ' (https://github.com/Kgoel07/MoodShift)',
    chrome.storage.session);
  const active = new Map<string, AbortController>();
  chrome.runtime.onMessage.addListener((message: LyricsRequest | LyricsCancel, sender, reply) => {
    if (message.target !== 'lyrics' || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    if ('cancel' in message) {
      active.get(`${sender.documentId}:${message.cancel}`)?.abort();
      return;
    }
    const query = message.query;
    if (!query || typeof query.title !== 'string' || typeof query.artist !== 'string') return;
    const id = typeof message.requestId === 'string' && message.requestId.length <= 40
      ? `${sender.documentId}:${message.requestId}` : undefined;
    const controller = id ? new AbortController() : undefined;
    if (id && controller) active.set(id, controller);
    void lookup.search(query, message.retry === true, controller?.signal).then(reply).finally(() => {
      if (id) active.delete(id);
    });
    return true;
  });
}
