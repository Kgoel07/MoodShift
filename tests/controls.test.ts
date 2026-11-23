import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { applyControls, controlIds, parseControlActions, parseControlResult, type ControlAction, type ControlState } from '../extension/src/shared/controls';
import { readDisplay } from '../extension/src/shared/display-settings';
import { neutralEffects, presets } from '../extension/src/shared/effects';
import { builtInBands } from '../extension/src/shared/equalizer';
import { defaultReverb } from '../extension/src/shared/reverb';
import { defaultTuning } from '../extension/src/shared/tuning';
import { silentFeatures } from '../extension/src/shared/types';
import { createApp } from '../server/src/index';
import { controlRequestSchema } from '../server/src/schema';

const state = (): ControlState => ({ effects: { ...neutralEffects, trebleDb: -2 }, tuning: defaultTuning(),
  reverb: { ...defaultReverb }, monitor: 'modified', stemMode: 'full', display: readDisplay({}) });
const libraries = { audio: [], eq: [] };
const set = (control: string, value: NonNullable<ControlAction['value']>): ControlAction => ({ control, operation: 'set', value });
const reset = (control: string): ControlAction => ({ control, operation: 'reset' });

describe('MoodShift command registry', () => {
  it('applies ordered, relative pitch changes alongside reverb and legacy effects and preserves other settings', () => {
    const before = state();
    before.tuning.pitch = { enabled: false, semitones: -1.3 };
    const plan = applyControls(before, [
      { control: 'pitch.semitones', operation: 'adjust', value: -2 }, set('reverb.preset', 'hall'),
      set('reverb.duration', 8), set('reverb.amount', 0.31), set('bassDb', 3.5),
    ], libraries);
    expect(plan.tuning.pitch).toEqual({ enabled: true, semitones: -3.3 });
    expect(plan.reverb).toEqual({ preset: 'hall', duration: 4, lastAmount: 0.31 });
    expect(plan.effects).toEqual({ ...before.effects, bassDb: 3.5, reverbMix: 0.31 });
    expect(plan.tuning.eq).toBe(before.tuning.eq);
    expect(before.tuning.pitch.semitones).toBe(-1.3);
    expect(applyControls(plan, [set('pitch.semitones', 99), set('pitch.enabled', false)], libraries).tuning.pitch)
      .toEqual({ enabled: false, semitones: 6 });
    expect(applyControls(plan, [reset('pitch.semitones')], libraries).tuning.pitch.semitones).toBe(0);
  });

  it('updates an addressed EQ band or adds, retunes, and removes a custom frequency', () => {
    const plan = applyControls(state(), [set('eq.preset', 'vocal'),
      { control: 'eq.frequency', operation: 'adjust', value: 4, frequency: 200 },
      { ...set('eq.bandwidth', 2.65), frequency: 200 }, { ...set('eq.move', 210), frequency: 200 },
      set('eq.treble', -6)], libraries);
    expect(plan.tuning.eq.bands.at(-1)).toMatchObject({ frequency: 210, q: 2.65, gain: 4 });
    expect(plan.tuning.eq.bands.find(band => band.id === 'treble')?.gain).toBe(-6);
    expect(applyControls(plan, [{ control: 'eq.remove', operation: 'remove', frequency: 210 }], libraries).tuning.eq.bands).toHaveLength(6);
    expect(applyControls(plan, [reset('eq.reset')], libraries).tuning.eq.bands).toEqual(builtInBands('balanced'));
    expect(() => applyControls(plan, [{ ...set('eq.move', 250), frequency: 300 }], libraries)).toThrow('before editing');
  });

  it('uses current built-ins and stored audio and EQ presets with validated mixes', () => {
    for (const name of Object.keys(presets) as Array<keyof typeof presets>) {
      expect(applyControls(state(), [set('preset', name)], libraries).effects).toEqual(presets[name]);
    }
    const preset = { name: 'Custom evening', audioSettings: { ...neutralEffects, reverbMix: 0.3 }, tuning: defaultTuning(),
      reverb: { ...defaultReverb }, monitor: 'original', stemMode: 'vocals' } as const;
    const eq = { id: 'eq:12345678-1234-4123-8123-123456789abc', name: 'EQ test', bands: builtInBands('warm') };
    const recalled = applyControls(state(), [set('preset.saved', preset.name), set('eq.saved', eq.name)], { audio: [preset], eq: [eq] });
    expect(recalled).toMatchObject({ effects: preset.audioSettings, selectStem: true, stemMode: 'vocals', monitor: 'original' });
    expect(recalled.tuning.eq.bands).toEqual(eq.bands);
    expect(() => applyControls(state(), [set('preset.saved', 'Unknown mix')], libraries)).toThrow('no longer available');
  });

  it('keeps display preferences through an audio reset and tracks the requested mix order', () => {
    const plan = applyControls(state(), [set('home.pitch', true), set('chords.open', true), set('lyrics.offset', 1.6),
      set('lyrics.follow', false), set('mix', 'instrumental'), set('mix', 'original')], libraries);
    expect(plan).toMatchObject({ monitor: 'original', stemMode: 'instrumental', selectStem: true,
      display: { home: { pitch: true }, chordsOpen: true, lyricsOffset: 1.6, lyricsFollow: false } });
    const clean = applyControls(plan, [reset('audio.reset')], libraries);
    expect(clean).toMatchObject({ effects: neutralEffects, tuning: defaultTuning(), monitor: 'modified', stemMode: 'full' });
    expect(clean.display).toBe(plan.display);
  });

  it('rejects unknown settings, arbitrary fields, wrong types, nulls, and unreasonable requests', () => {
    for (const action of [set('__proto__', true), set('permissions.microphone', true), set('mix', 'drums'), set('pitch.semitones', '2'),
      set('pitch.semitones', Infinity), set('pitch.enabled', null as never), { ...set('bassDb', 2), js: 'alert()' },
      { ...set('eq.frequency', 4), frequency: 10 }, { ...reset('eq.reset'), value: 3 }, { ...set('pitch.enabled', true), operation: 'adjust' }]) {
      expect(() => parseControlActions([action])).toThrow();
    }
    expect(() => parseControlActions(Array.from({ length: 13 }, () => set('pitch.enabled', true)))).toThrow();
    expect(() => parseControlResult({ actions: [], unsupported: ['x'.repeat(121)], summary: 'Unrelated' })).toThrow();
  });
});

it('serves the v2 route through Express and generates Gemini’s schema from the same registry', async () => {
  const result = { actions: [{ control: 'pitch.semitones', operation: 'adjust', value: -2 }, set('reverb.preset', 'hall')],
    summary: 'Lower the pitch and add Concert Hall.', unsupported: [] };
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ candidates: [{ finishReason: 'STOP',
    content: { parts: [{ text: JSON.stringify(result) }] } }] }));
  const server = createApp({ apiKey: 'test-key', model: 'gemini-3.1-flash-lite' }, upstream).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(base + '/health')).headers.get('x-moodshift-controls')).toBe('2');
    const { effects, ...controls } = state();
    const request = { prompt: 'Lower pitch by two and apply concert hall', currentEffects: effects,
      audioFeatures: silentFeatures, controls: { ...controls, savedEq: [], savedAudio: [], youtubeWatch: false } };
    const response = await fetch(base + '/api/interpret/v2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    const provider = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(provider.generationConfig.responseJsonSchema.properties.actions.items.properties.control.enum).toEqual(controlIds);
    expect(provider.systemInstruction.parts[0].text).toContain('Independent pitch in semitones');
    expect(JSON.parse(provider.contents[0].parts[0].text).controls.tuning).toEqual(controls.tuning);
    expect(controlRequestSchema.safeParse({ ...request, controls: { ...request.controls, authentication: 'test' } }).success).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
