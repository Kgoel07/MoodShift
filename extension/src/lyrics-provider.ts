import { parseLrc, trackKey, validSong, type LyricsRequest, type LyricsResult, type SongQuery } from './shared/lyrics';

type Available = Extract<LyricsResult, { kind: 'synced' | 'plain' }> | { kind: 'instrumental' };
interface Candidate {
  difference: number;
  lyrics: Available;
}

export function matchLyrics(payload: unknown, song: SongQuery): LyricsResult {
  if (!Array.isArray(payload)) return { kind: 'error' };
  const candidates: Candidate[] = [];
  const title = trackKey(song.title);
  const artist = trackKey(song.artist);
  for (const row of payload.slice(0, 20)) {
    if (!row || typeof row !== 'object' || typeof row.trackName !== 'string' || typeof row.artistName !== 'string'
      || typeof row.duration !== 'number' || !Number.isFinite(row.duration)) continue;
    const difference = Math.abs(row.duration - song.duration);
    if (difference > 2 || trackKey(row.trackName) !== title || trackKey(row.artistName) !== artist) continue;

    const plain = typeof row.plainLyrics === 'string' && row.plainLyrics.length <= 32_000 ? row.plainLyrics.trim() : '';
    const timed = typeof row.syncedLyrics === 'string' && row.syncedLyrics.length <= 32_000
      ? parseLrc(row.syncedLyrics) : [];
    const reliableTiming = timed.some(line => line.text) && timed.length <= 1_500
      && timed.at(-1)!.time < song.duration + 2;
    if (row.instrumental === true) candidates.push({ difference, lyrics: { kind: 'instrumental' } });
    else if (reliableTiming) candidates.push({ difference, lyrics: { kind: 'synced', lines: timed } });
    else if (plain) candidates.push({ difference, lyrics: { kind: 'plain', text: plain } });
  }

  candidates.sort((left, right) => left.difference - right.difference);
  const nearest = candidates[0];
  if (!nearest) return { kind: 'missing' };
  const close = candidates.filter(candidate => candidate.difference <= nearest.difference + 0.75);
  const selected = close.find(candidate => candidate.lyrics.kind === 'synced') ?? nearest;

  const signature = (result: Available): string => {
    if (result.kind === 'instrumental') return '';
    return trackKey(result.kind === 'plain' ? result.text : result.lines.map(line => line.text).join(' '));
  };
  const selectedText = signature(selected.lyrics);
  for (const { lyrics, difference } of close) {
    // A markedly closer duration can distinguish releases with the same title and artist.
    if (Math.abs(difference - selected.difference) > 0.25) continue;
    if (lyrics.kind !== selected.lyrics.kind && lyrics.kind !== 'instrumental'
      && selected.lyrics.kind !== 'instrumental') continue;
    if (signature(lyrics) !== selectedText) return { kind: 'ambiguous' };
    if (lyrics.kind === 'synced' && selected.lyrics.kind === 'synced') {
      const selectedLines = selected.lyrics.lines.filter(line => line.text);
      const otherLines = lyrics.lines.filter(line => line.text);
      if (otherLines.length !== selectedLines.length
        || otherLines.some((line, index) => Math.abs(line.time - selectedLines[index].time) > 2)) {
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
  private requests = new Map<string, Promise<LyricsResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly client: string,
    private readonly storage?: chrome.storage.StorageArea,
  ) {}

  search(song: SongQuery, retry = false): Promise<LyricsResult> {
    if (!validSong(song)) return Promise.resolve({ kind: 'invalid' });
    const key = JSON.stringify([trackKey(song.title), trackKey(song.artist), Math.round(song.duration * 10)]);
    const pending = this.requests.get(key);
    if (pending) return pending;
    if (this.requests.size >= 4) return Promise.resolve({ kind: 'error' });
    const request = this.tail.then(async () => {
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

      const result = await this.fetchLyrics(song, state);
      state.lastFinished = Date.now();
      if (result.kind !== 'limited' && result.kind !== 'error') {
        const lifetime = result.kind === 'synced' || result.kind === 'plain' ? 30 * 60_000 : 5 * 60_000;
        state.cache = [{ key, result, expiry: state.lastFinished + lifetime },
          ...state.cache.filter(entry => entry.key !== key)].slice(0, 12);
      }
      await this.storage?.set({ [storageKey]: state }).catch(() => undefined);
      return result;
    }).catch((): LyricsResult => ({ kind: 'error' })).finally(() => this.requests.delete(key));
    this.tail = request;
    this.requests.set(key, request);
    return request;
  }

  private empty(): LookupState {
    return { cache: [], retryAt: 0, lastFinished: 0 };
  }

  private async fetchLyrics(song: SongQuery, state: LookupState): Promise<LyricsResult> {
    const endpoint = new URL('https://lrclib.net/api/search');
    endpoint.searchParams.set('track_name', song.title.trim());
    endpoint.searchParams.set('artist_name', song.artist.trim());
    try {
      const response = await this.fetcher(endpoint, {
        headers: { 'X-User-Agent': this.client, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
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
  chrome.runtime.onMessage.addListener((message: LyricsRequest, sender, reply) => {
    if (message.target !== 'lyrics' || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    const query = message.query;
    if (!query || typeof query.title !== 'string' || typeof query.artist !== 'string') return;
    void lookup.search(query, message.retry === true).then(reply);
    return true;
  });
}
