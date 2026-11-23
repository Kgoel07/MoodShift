import { defaultReverb, reverbDuration, reverbPresets, type ReverbPatch } from './shared/reverb';
import { effectSpecs } from './shared/effects';
import type { CaptureStatus } from './shared/types';
import { paintRange } from './range-control';

export function mountReverb(root: HTMLElement, change: (patch: ReverbPatch) => void, editing: () => void) {
  const controls = root.querySelector<HTMLFieldSetElement>('fieldset')!;
  const enabled = root.querySelector<HTMLInputElement>('#reverb-enabled')!;
  const preset = root.querySelector<HTMLSelectElement>('#reverb-preset')!;
  const amount = root.querySelector<HTMLInputElement>('#effect-reverbMix')!;
  const duration = root.querySelector<HTMLInputElement>('#reverb-duration')!;
  const amountLabel = root.querySelector<HTMLOutputElement>('#reverb-amount-value')!;
  const durationLabel = root.querySelector<HTMLOutputElement>('#reverb-duration-value')!;
  const notice = root.querySelector<HTMLElement>('[role=status]')!;
  let durationEditing = false;
  let sessionId: string | undefined;
  amount.max = String(effectSpecs.reverbMix.max);
  duration.min = String(reverbDuration.min); duration.max = String(reverbDuration.max); duration.step = String(reverbDuration.step);
  for (const [key, definition] of Object.entries(reverbPresets)) preset.add(new Option(definition.label, key));
  enabled.addEventListener('change', () => { editing(); change({ enabled: enabled.checked }); });
  preset.addEventListener('change', () => { editing(); change({ preset: preset.value as keyof typeof reverbPresets }); });
  amount.addEventListener('input', () => {
    editing(); paintRange(amount); amountLabel.value = `${Math.round(amount.valueAsNumber * 100)}%`; change({ amount: amount.valueAsNumber });
  });
  duration.addEventListener('input', () => { editing(); durationEditing = true; paintRange(duration); durationLabel.value = `${duration.valueAsNumber.toFixed(1)} s`; });
  duration.addEventListener('change', () => { editing(); durationEditing = false; change({ duration: duration.valueAsNumber }); });
  return {
    render(status: CaptureStatus, ready: boolean) {
      controls.disabled = !ready;
      const capture = status.phase === 'capturing' ? status : undefined;
      if (capture?.session.id !== sessionId) { durationEditing = false; sessionId = capture?.session.id; }
      const settings = capture?.reverb ?? defaultReverb;
      const mix = capture?.effects.reverbMix ?? 0;
      enabled.checked = mix > 0; preset.value = settings.preset;
      amount.value = String(mix); amountLabel.value = `${Math.round(mix * 100)}%`;
      if (!durationEditing) { duration.value = String(settings.duration); durationLabel.value = `${settings.duration.toFixed(1)} s`; }
      paintRange(amount);
      paintRange(duration);
      const speed = capture?.reverb?.speed;
      notice.textContent = mix > 0 && settings.preset === 'slowed'
        ? speed?.state === 'active' ? `Playback slowed to ${Number(speed.rate!.toFixed(2))}×` : speed?.message ?? 'Reverb active. Playback slowing is unavailable.' : '';
    },
  };
}
