import { describe, expect, it } from 'vitest';
import { rangeFill, readHomeLayout } from '../extension/src/shared/home-layout';
import { platformFor, trackTitle, youtubeArtwork } from '../extension/src/shared/track';

describe('Home layout', () => {
  it('defaults to lyrics and stems and reads saved flags independently', () => {
    expect(readHomeLayout(undefined)).toEqual({ lyrics: true, stems: true, reverb: false, controls: false, presets: false });
    expect(readHomeLayout({ lyrics: false, reverb: true, stems: 'false', extra: true }))
      .toEqual({ lyrics: false, stems: true, reverb: true, controls: false, presets: false });
    expect(readHomeLayout([])).toEqual(readHomeLayout(null));
    expect(readHomeLayout(Object.create({ lyrics: false })).lyrics).toBe(true);
  });

  it('fills negative and fractional ranges without changing slider values', () => {
    expect(rangeFill(0, -12, 8)).toBe(60);
    expect(rangeFill(0.275, 0, 0.55)).toBe(50);
    expect(rangeFill(-8, 0, 4)).toBe(0);
    expect(rangeFill(8, 0, 4)).toBe(100);
    expect(rangeFill(2, 1, 1)).toBe(0);
  });
});

describe('source labels and artwork', () => {
  it('recognizes only actual platform domains and removes a known title suffix', () => {
    expect(platformFor('https://www.youtube.com/watch?v=kTJczUoc26U')).toBe('youtube');
    expect(platformFor('https://open.spotify.com/track/id')).toBe('spotify');
    expect(platformFor('https://m.soundcloud.com/artist/track')).toBe('soundcloud');
    for (const url of ['https://youtube.com.evil.invalid/', 'https://notspotify.com/', 'file:///c:/music.mp3', undefined]) {
      expect(platformFor(url)).toBe('tab');
    }
    expect(trackTitle('Music - YouTube', 'youtube')).toBe('Music');
    expect(trackTitle('Music - YouTube', 'tab')).toBe('Music - YouTube');
  });

  it('builds images only on the known thumbnail host with a valid video ID', () => {
    expect(youtubeArtwork('kTJczUoc26U')).toBe('https://i.ytimg.com/vi/kTJczUoc26U/mqdefault.jpg');
    for (const id of ['../anything', 'https://example.com/img', 'short', 'тест1234567']) expect(youtubeArtwork(id)).toBeUndefined();
  });
});
