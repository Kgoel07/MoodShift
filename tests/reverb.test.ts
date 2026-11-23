import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeReverb, defaultReverb, reverbPresets, validateReverb } from '../extension/src/shared/reverb';
import { impulseSamples, LocalReverb } from '../extension/src/reverb';
import { PlaybackSpeedLease } from '../extension/src/playback-speed';

afterEach(() => { vi.useRealTimers(); });
describe('local reverb settings and signals', () => {
  it('keeps presets distinct, clamps controls, preserves settings when toggled, and rejects malformed changes', () => {
    const configurations = Object.keys(reverbPresets).map(preset => changeReverb(defaultReverb, 0, { preset }));
    expect(new Set(configurations.map(value => JSON.stringify(value))).size).toBe(3);
    for (const config of configurations) {
      const custom = changeReverb(config.settings, config.mix, { amount: 0.19, duration: 1.1 });
      const off = changeReverb(custom.settings, custom.mix, { enabled: false });
      expect(off.mix).toBe(0);
      expect(changeReverb(off.settings, 0, { enabled: true })).toEqual(custom);
    }
    expect(changeReverb(defaultReverb, 0, { amount: 8, duration: 50 })).toMatchObject({ mix: 0.55, settings: { duration: 4 } });
    expect(validateReverb({ ...defaultReverb, duration: -1 }).duration).toBe(0.4);
    for (const patch of [{ amount: NaN }, { duration: Infinity }, { preset: 'unknown' }, { enabled: 'yes' }, { code: 'evil' }, []]) {
      expect(() => changeReverb(defaultReverb, 0, patch)).toThrow();
    }
  });

  it('generates deterministic, finite, decaying stereo responses at both device rates', () => {
    for (const rate of [44100, 48000]) {
      for (const preset of Object.keys(reverbPresets) as (keyof typeof reverbPresets)[]) {
        const settings = { ...defaultReverb, preset, duration: reverbPresets[preset].duration };
        const [left, right] = impulseSamples(rate, settings);
        expect(left.length).toBe(Math.ceil(rate * settings.duration));
        expect(left.every(Number.isFinite)).toBe(true);
        const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample ** 2, 0);
        expect(energy(left)).toBeCloseTo(1, 5);
        expect(energy(left.subarray(Math.floor(left.length * 0.8)))).toBeLessThan(0.001);
        expect(left).not.toEqual(right);
        expect(impulseSamples(rate, settings)[0]).toEqual(left);
      }
    }
  });

  it('leaves one neutral dry path, coalesces scrubbing, reuses responses and disconnects wet processing', async () => {
    vi.useFakeTimers();
    const param = () => ({ value: 1, cancelAndHoldAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
    const node = () => ({ gain: param(), connect: vi.fn(function(this: unknown, next) { return next; }), disconnect: vi.fn() });
    const input = node(), output = node();
    const context = { sampleRate: 48000, currentTime: 0, createGain: vi.fn(node), createConvolver: vi.fn(node),
      createBuffer: vi.fn((_channels, size) => ({ getChannelData: () => new Float32Array(size) })) };
    const engine = new LocalReverb(context as unknown as AudioContext, input as unknown as AudioNode, output as unknown as AudioNode);
    expect(context.createConvolver).not.toHaveBeenCalled();
    engine.update(defaultReverb, 0.3);
    engine.update({ ...defaultReverb, duration: 3 }, 0.3);
    engine.update(defaultReverb, 0.3);
    await vi.advanceTimersByTimeAsync(100);
    expect(context.createBuffer).toHaveBeenCalledTimes(1);
    engine.update(defaultReverb, 0.4);
    await vi.advanceTimersByTimeAsync(100);
    expect(context.createConvolver).toHaveBeenCalledTimes(1);
    engine.update(defaultReverb, 0); await vi.advanceTimersByTimeAsync(400);
    expect(context.createConvolver.mock.results[0].value.disconnect).toHaveBeenCalled();
    engine.update(defaultReverb, 0.3); await vi.advanceTimersByTimeAsync(100);
    expect(context.createBuffer).toHaveBeenCalledTimes(1);
    engine.disconnect(); await vi.advanceTimersByTimeAsync(500);
    expect(context.createConvolver.mock.results[1].value.disconnect).toHaveBeenCalled();
  });
});

describe('scoped playback speed lease', () => {
  function player(rate = 1.25) { return { playbackRate: rate, duration: 180 } as HTMLMediaElement; }
  it('restores the original rate on disable and expiry and never compounds a renewal', () => {
    vi.useFakeTimers(); const lease = new PlaybackSpeedLease(), media = player();
    expect(lease.set('session', true, media)).toEqual({ state: 'active', rate: 1.0625 });
    lease.set('session', true, media); expect(media.playbackRate).toBe(1.0625);
    lease.set('session', false); expect(media.playbackRate).toBe(1.25);
    lease.set('session', true, media); vi.advanceTimersByTime(7100); expect(media.playbackRate).toBe(1.25);
  });
  it('preserves a user override and releases old players while handling unavailable sources', () => {
    vi.useFakeTimers(); const lease = new PlaybackSpeedLease(), first = player(), second = player(1);
    lease.set('first', true, first); lease.set('second', true, second);
    expect(first.playbackRate).toBe(1.25); expect(second.playbackRate).toBe(0.85);
    lease.set('first', false); expect(second.playbackRate).toBe(0.85);
    second.playbackRate = 1.1;
    expect(lease.set('second', true, second).state).toBe('unavailable');
    lease.set('second', false); expect(second.playbackRate).toBe(1.1);
    expect(lease.set('none', true).state).toBe('unavailable');
    expect(lease.set('extreme', true, player(4)).state).toBe('unavailable');
    const refusing = player(); Object.defineProperty(refusing, 'playbackRate', { get: () => 1.25, set: () => {} });
    expect(lease.set('refusing', true, refusing).state).toBe('unavailable');
  });
});
