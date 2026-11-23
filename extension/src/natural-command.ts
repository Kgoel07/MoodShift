import { apiErrorDetail, apiRequest, CloudAccessError } from './api-client';
import { controlState, loadControlPresets, loadDisplay } from './control-state';
import { editLocalPreference, promptPreferences } from './local-preferences';
import { controlPresetLimit, parseControlResult, type ControlAction, type ControlResult } from './shared/controls';
import { effectKeys, neutralEffects } from './shared/effects';
import { toWorker } from './shared/messages';
import { explicitPreference } from './shared/preferences';
import { directStemIntent, parseInterpretation, silentFeatures, type CaptureStatus } from './shared/types';

export class CommandFeedbackError extends Error {}
type CommandResult = { message: string; status?: CaptureStatus };
type Options = { signal: AbortSignal; sessionId?: string; applying?: () => void };

function legacyResult(input: unknown, effects: typeof neutralEffects): ControlResult {
  const result = parseInterpretation(input, effects);
  const changes = result.mode === 'reset' ? neutralEffects : result.patch;
  const actions: ControlAction[] = [];
  for (const key of effectKeys) {
    if (changes[key] === undefined) continue;
    actions.push({ control: key === 'reverbMix' ? 'reverb.amount' : key, operation: 'set', value: changes[key] });
  }
  if (result.stemMode) actions.push({ control: 'mix', operation: 'set', value: result.stemMode });
  return { actions, summary: result.summary, unsupported: result.unsupported };
}

export async function runNaturalCommand(text: string, options: Options): Promise<CommandResult> {
  const prompt = text.trim();
  if (!prompt || prompt.length > 500) throw new CommandFeedbackError('Try a short audio command of up to 500 characters.');
  options.signal.throwIfAborted();
  const reply = await toWorker({ type: 'GET_STATUS' });
  if (!reply.ok || reply.status.phase !== 'capturing' || (options.sessionId && reply.status.session.id !== options.sessionId)) {
    throw new CommandFeedbackError('Select a playing tab with the MoodShift icon first.');
  }
  const capture = reply.status;
  const preference = explicitPreference(prompt);
  if (preference) {
    options.signal.throwIfAborted();
    await editLocalPreference({ text: preference });
    return { message: 'Preference saved on this device.' };
  }

  const [display, saved, localPreferences] = await Promise.all([
    loadDisplay(), loadControlPresets(), promptPreferences(prompt).catch(() => undefined),
  ]);
  options.signal.throwIfAborted();
  const { session, effects, revision, features, outputPaused } = capture;
  const direct = directStemIntent(prompt);
  let result: ControlResult;
  let legacy = false;
  if (direct === 'unsupported') return { message: 'Unsupported · Beat, drum and bass isolation require separate stems.' };
  if (direct) {
    result = { actions: [{ control: 'mix', operation: 'set', value: direct }],
      summary: direct === 'full' ? 'Full Mix' : direct === 'vocals' ? 'Vocals' : 'Instrumental', unsupported: [] };
  } else {
    const request = { prompt, currentEffects: effects, audioFeatures: session.muted || outputPaused ? silentFeatures : features, localPreferences };
    const { effects: _effects, ...settings } = controlState(capture, display);
    const names = (rows: readonly { name: string }[]) => rows.map(row => row.name)
      .filter(name => !/[\u0000-\u001f\u007f]/.test(name)).slice(0, controlPresetLimit);
    const deadline = AbortSignal.timeout(15_000);
    const signal = AbortSignal.any([options.signal, deadline]);
    try {
      let response = await apiRequest('/api/interpret/v2', { ...request, controls: {
        ...settings, savedAudio: names(saved.audio), savedEq: names(saved.eq), youtubeWatch: session.platform === 'youtube',
      } }, signal);
      if (response.status === 404) {
        legacy = true;
        await response.body?.cancel();
        response = await apiRequest('/api/interpret', request, signal);
      }
      if (response.status === 504) throw new CommandFeedbackError('Gemini timed out. Try again.');
      if (response.status >= 500) throw new CommandFeedbackError('Gemini unavailable. Presets and manual controls still work.');
      if (!response.ok) throw new CommandFeedbackError(apiErrorDetail(response));
      const body: unknown = await response.json();
      result = legacy ? legacyResult(body, effects) : parseControlResult(body);
    } catch (error) {
      options.signal.throwIfAborted();
      if (deadline.aborted) throw new CommandFeedbackError('Gemini timed out. Try again.');
      if (error instanceof TypeError) throw new CommandFeedbackError('Gemini unavailable. Presets and manual controls still work.');
      if (error instanceof CloudAccessError) throw new CommandFeedbackError(error.message);
      throw error;
    }
  }

  const limitation = result.unsupported.length ? ` Unsupported · ${result.unsupported.join(', ')}` : '';
  if (!result.actions.length) return { message: `${result.summary}${limitation}${legacy && limitation ? ' The configured backend uses the older command API.' : ''}` };
  options.signal.throwIfAborted();
  options.applying?.();
  const changed = await toWorker({ type: 'APPLY_CONTROLS', sessionId: session.id, baseRevision: revision,
    actions: result.actions, expectedDisplay: display });
  if (!changed.ok) throw new CommandFeedbackError(changed.message);
  let confirmation = result.summary;
  const pitch = changed.status.tuning?.pitch;
  if (pitch && result.actions.every(action => action.control.startsWith('pitch.'))) {
    confirmation = pitch.enabled ? `Pitch ${pitch.semitones > 0 ? '+' : ''}${pitch.semitones.toFixed(1)} st.` : 'Pitch off.';
  }
  const notices = changed.notices ?? [];
  const message = notices.length ? `${changed.applied ? 'Settings updated. ' : ''}${notices.join(' ')}`
    : changed.applied ? `Applied ✓ · ${confirmation}` : `Already set. ${confirmation}`;
  return { message: message + limitation, status: changed.status };
}
