import { toWorker } from './shared/messages';
import { changeTuning, defaultTuning, type TuningEdit, type TuningSettings } from './shared/tuning';
import type { CaptureStatus } from './shared/types';

export interface TuningView { settings: TuningSettings; status: CaptureStatus; ready: boolean; }
type Edit = { sessionId?: string; action: TuningEdit };
const sessionId = (status: CaptureStatus) => status.phase === 'capturing' ? status.session.id : undefined;

function mergeEdit(a: TuningEdit, b: TuningEdit): TuningEdit | undefined {
  if (a.kind === 'pitch' && b.kind === 'pitch') return { kind: 'pitch', patch: { ...a.patch, ...b.patch } };
  if (a.kind === 'eq-band' && b.kind === 'eq-band' && a.id === b.id) return { ...b, patch: { ...a.patch, ...b.patch } };
}

/** Projects pending gestures while the offscreen graph serializes and acknowledges every edit. */
export class TuningClient {
  private readonly listeners = new Set<(view: TuningView) => void>();
  private readonly queue: Edit[] = [];
  private current: CaptureStatus = { phase: 'ready' };
  private inFlight?: Edit;
  private timer?: ReturnType<typeof setTimeout>;
  private loaded = false;
  private request = 0;

  constructor(private readonly report: (message: string) => void, private readonly editing = () => {}) {}

  get busy(): boolean { return Boolean(this.queue.length || this.inFlight); }

  get view(): TuningView {
    let settings = this.current.tuning ?? defaultTuning();
    const source = sessionId(this.current);
    for (const pending of [this.inFlight, ...this.queue]) {
      if (!pending || pending.sessionId !== source) continue;
      try { settings = changeTuning(settings, pending.action); } catch { /* The point can be removed in another editor. */ }
    }
    return { settings, status: this.current, ready: this.loaded && this.current.phase !== 'starting' };
  }

  subscribe(listener: (view: TuningView) => void): void {
    this.listeners.add(listener);
    listener(this.view);
  }

  private notify(): void {
    const view = this.view;
    for (const listener of this.listeners) listener(view);
  }

  accept(status: CaptureStatus): void {
    if (status.phase === 'capturing' && this.current.phase === 'capturing'
      && status.session.id === this.current.session.id && status.revision < this.current.revision) return;
    this.current = status;
    this.loaded = Boolean(status.tuning);
    this.notify();
  }

  async refresh(): Promise<void> {
    const id = ++this.request;
    try {
      const reply = await toWorker({ type: 'GET_STATUS' });
      if (id === this.request && reply.ok) this.accept(reply.status);
    } catch (error) {
      console.warn('MoodShift tuning status unavailable', error);
      if (id === this.request) this.report('Couldn’t load audio settings. Reopen MoodShift to reconnect.');
    }
  }

  edit(action: TuningEdit, scrub = false): void {
    if (!this.view.ready) return;
    try { changeTuning(this.view.settings, action); }
    catch (error) { this.report(error instanceof Error ? error.message : 'Couldn’t edit this setting.'); return; }
    this.editing();
    const source = sessionId(this.current);
    const tail = this.queue.at(-1);
    const merged = tail && tail.sessionId === source ? mergeEdit(tail.action, action) : undefined;
    if (merged) tail!.action = merged;
    else this.queue.push({ sessionId: source, action });
    this.report('');
    this.notify();
    if (scrub) this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, 42);
    else {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return;
    while (this.queue.length && !this.timer) {
      const pending = this.queue.shift()!;
      if (pending.sessionId !== sessionId(this.current)) continue;
      this.inFlight = pending;
      let acknowledged: CaptureStatus | undefined;
      try {
        const reply = await toWorker({ type: 'SET_TUNING', sessionId: pending.sessionId, edit: pending.action });
        if (!reply.ok) throw new Error(reply.message);
        acknowledged = reply.status;
      } catch (error) {
        console.warn('MoodShift tuning edit failed', error);
        this.report('Couldn’t update this audio setting. Please try again.');
      } finally {
        this.inFlight = undefined;
      }
      if (acknowledged && pending.sessionId === sessionId(this.current)) this.accept(acknowledged);
      else {
        this.notify();
        void this.refresh();
      }
    }
  }
}
