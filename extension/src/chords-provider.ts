import { normalizeSongle, validChordVideo, type ChordResult } from './shared/chords';
import type { YouTubePlayback } from './shared/lyrics';

export type ChordProvider = (videoId: string) => Promise<ChordResult>;
const cacheKey = 'songleChordCacheV1';
const cacheAge = 7 * 24 * 60 * 60 * 1000;
type Cache = Record<string, { savedAt: number; result: Extract<ChordResult, { kind: 'found' }> }>;
const pending = new Map<string, Promise<ChordResult>>();
let cacheWrite = Promise.resolve();

export async function fetchSongle(videoId: string, fetcher = fetch): Promise<ChordResult> {
  const endpoint = new URL('https://widget.songle.jp/api/v1/song/chord.json');
  endpoint.searchParams.set('url', `www.youtube.com/watch?v=${videoId}`);
  try {
    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(4500), credentials: 'omit' });
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return { kind: 'unavailable' };
    const json: unknown = await response.json();
    return normalizeSongle(json);
  } catch (error) {
    return { kind: error instanceof SyntaxError ? 'invalid' : 'unavailable' };
  }
}

async function load(videoId: string): Promise<ChordResult> {
  try {
    const values = await chrome.storage.local.get(cacheKey);
    const hit = (values[cacheKey] as Cache | undefined)?.[videoId];
    if (hit?.result?.kind === 'found' && Date.now() - hit.savedAt < cacheAge) return hit.result;
  } catch {
    // A cache failure must not prevent fetching chords.
  }
  const result = await fetchSongle(videoId);
  if (result.kind === 'found') {
    const write = cacheWrite.then(async () => {
      const values = await chrome.storage.local.get(cacheKey);
      const entries = Object.entries(values[cacheKey] ?? {}).filter(([id]) => id !== videoId);
      await chrome.storage.local.set({
        [cacheKey]: Object.fromEntries([...entries.slice(-15), [videoId, { savedAt: Date.now(), result }]]),
      });
    });
    cacheWrite = write.catch(() => undefined);
    await cacheWrite;
  }
  return result;
}

export function installChordLookup(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== 'chords' || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    const videoId: unknown = message.videoId;
    if (!validChordVideo(videoId)) {
      respond({ kind: 'invalid' } satisfies ChordResult);
      return;
    }
    let request = pending.get(videoId);
    if (!request) {
      request = load(videoId).finally(() => pending.delete(videoId));
      pending.set(videoId, request);
    }
    void request.then(respond, () => respond({ kind: 'unavailable' }));
    return true;
  });
}

export class ChordSession {
  private videoId?: string;
  private revision = 0;
  result?: ChordResult;

  constructor(private readonly provider: ChordProvider, private readonly render: () => void) {}

  setPlayback(playback: YouTubePlayback | null): void {
    const valid = playback && validChordVideo(playback.videoId);
    const id = valid ? playback.videoId : undefined;
    if (id !== this.videoId) {
      this.videoId = id;
      this.revision++;
      this.result = undefined;
    }
    if (id && playback && Number.isFinite(playback.song.duration) && playback.song.duration > 0
      && !playback.ad && !this.result && this.requested !== this.revision) {
      void this.lookup(id);
    }
  }

  private requested = -1;

  private async lookup(id: string): Promise<void> {
    const revision = this.revision;
    this.requested = revision;
    const result = await this.provider(id).catch((): ChordResult => ({ kind: 'unavailable' }));
    if (revision === this.revision) {
      this.result = result;
      this.render();
    }
  }

  retry(): void {
    if (this.videoId && this.result?.kind !== 'found' && this.result) {
      this.result = undefined;
      void this.lookup(this.videoId);
      this.render();
    }
  }
}
