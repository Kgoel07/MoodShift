import { EqChart, frequencyLabel, gainLabel } from './eq-chart';
import { mountEqPresetControls } from './eq-preset-controls';
import { paintRange } from './range-control';
import { defaultBands, eqRange } from './shared/equalizer';
import { pitchRange } from './shared/pitch';
import type { TuningClient } from './tuning-client';

export function mountPitch(root: HTMLElement, client: TuningClient): void {
  const enabled = root.querySelector<HTMLInputElement>('#pitch-enabled')!;
  const slider = root.querySelector<HTMLInputElement>('#pitch-value')!;
  const value = root.querySelector<HTMLOutputElement>('#pitch-readout')!;
  const reset = root.querySelector<HTMLButtonElement>('#pitch-reset')!;
  const notice = root.querySelector<HTMLElement>('#pitch-status')!;
  const controls = root.querySelector<HTMLFieldSetElement>('fieldset')!;
  slider.min = String(pitchRange.min);
  slider.max = String(pitchRange.max);
  slider.step = String(pitchRange.step);
  enabled.addEventListener('change', () => client.edit({ kind: 'pitch', patch: { enabled: enabled.checked } }));
  slider.addEventListener('input', () => client.edit({ kind: 'pitch', patch: { enabled: true, semitones: slider.valueAsNumber } }, true));
  slider.addEventListener('change', () => client.edit({ kind: 'pitch', patch: { enabled: true, semitones: slider.valueAsNumber } }));
  reset.addEventListener('click', () => client.edit({ kind: 'pitch', patch: { semitones: 0 } }));

  client.subscribe(({ settings, status, ready }) => {
    const { pitch } = settings;
    const playback = status.phase === 'capturing' ? status.audioTiming?.pitch : undefined;
    controls.disabled = !ready;
    enabled.checked = pitch.enabled;
    slider.value = String(pitch.semitones);
    value.value = `${gainLabel(pitch.semitones)} st`;
    slider.setAttribute('aria-valuetext', `${gainLabel(pitch.semitones)} semitones`);
    reset.disabled = pitch.semitones === 0;
    paintRange(slider);
    let text = '';
    switch (playback?.phase) {
      case 'starting': text = 'Starting pitch control…'; break;
      case 'unavailable': text = 'Pitch could not start. Turn it off and on to try again.'; break;
    }
    if (notice.textContent !== text) notice.textContent = text;
  });
}

export function mountCompactEq(root: HTMLElement, client: TuningClient, report: (message: string) => void): void {
  const graph = new EqChart(root.querySelector('canvas')!, true);
  const enabled = root.querySelector<HTMLInputElement>('#eq-enabled')!;
  const reset = root.querySelector<HTMLButtonElement>('#eq-reset')!;
  const controls = root.querySelector<HTMLFieldSetElement>('fieldset')!;
  const bands = root.querySelector('#eq-bands')!;
  const expand = root.querySelector<HTMLButtonElement>('#open-domain')!;

  const knobs = defaultBands.map(({ id, name }) => {
    const label = document.createElement('label');
    const value = document.createElement('output');
    const frequency = document.createElement('span');
    const track = document.createElement('span');
    const input = document.createElement('input');
    label.className = 'eq-band';
    track.className = 'eq-slider-track';
    input.id = `eq-band-${id}`;
    input.type = 'range';
    input.min = String(eqRange.minGain);
    input.max = String(eqRange.maxGain);
    input.step = '0.1';
    input.setAttribute('aria-orientation', 'vertical');
    value.htmlFor = input.id;
    track.append(input);
    label.append(value, track, frequency);
    bands.append(label);
    const edit = (scrub: boolean) => client.edit({ kind: 'eq-band', id, patch: { gain: input.valueAsNumber } }, scrub);
    input.addEventListener('input', () => edit(true));
    input.addEventListener('change', () => edit(false));
    return { id, name, input, value, frequency };
  });
  enabled.addEventListener('change', () => client.edit({ kind: 'eq-enabled', enabled: enabled.checked }));
  reset.addEventListener('click', () => client.edit({ kind: 'eq-reset' }));
  expand.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('domain.html') }).catch(error => {
      console.warn('MoodShift could not open Domain Expansion', error);
      report('Couldn’t open Domain Expansion. Please try again.');
    });
  });
  mountEqPresetControls(root, client, report);
  client.subscribe(({ settings, status, ready }) => {
    controls.disabled = !ready;
    enabled.checked = settings.eq.enabled;
    graph.setEq(settings.eq, status.phase === 'capturing' ? status.audioTiming?.sampleRate : undefined);
    for (const [i, { name, input, value, frequency }] of knobs.entries()) {
      const band = settings.eq.bands[i];
      const db = gainLabel(band.gain);
      input.value = String(band.gain);
      input.setAttribute('aria-label', `${name}, ${band.frequency} Hz`);
      input.setAttribute('aria-valuetext', `${db} dB`);
      value.value = db;
      frequency.textContent = frequencyLabel(band.frequency);
      frequency.title = `${band.frequency} Hz`;
      paintRange(input);
    }
  });
}
