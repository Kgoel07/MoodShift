export const platforms = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud', tab: 'Browser audio' } as const;
export type SourcePlatform = keyof typeof platforms;

export function platformFor(url?: string): SourcePlatform {
  try {
    const { protocol, hostname } = new URL(url ?? '');
    if (protocol !== 'https:' && protocol !== 'http:') return 'tab';
    const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (matches('youtube.com') || matches('youtu.be')) return 'youtube';
    if (matches('spotify.com')) return 'spotify';
    if (matches('soundcloud.com')) return 'soundcloud';
  } catch { /* A source URL can be unavailable. */ }
  return 'tab';
}

export function youtubeArtwork(videoId: string): string | undefined {
  if (/^[\w-]{11}$/.test(videoId)) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export function trackTitle(title: string, platform: SourcePlatform): string {
  const suffix = ` - ${platforms[platform]}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() || title : title;
}
