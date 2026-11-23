import { ChordSession } from './chords-provider';
import { chordPosition, chordPositionAt, guitarFrets, liveChordPort, LiveChordTimeline, pianoNotes,
  type ChordEvent, type ChordResult, type LiveChordSample } from './shared/chords';
import { playbackKey, type PlayerPlayback } from './shared/lyrics';
import { observeDisplay, setDisplay } from './display-client';

const pianoKeys = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const element = (tag: string, content: string) => {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
};

const songleStatus: Record<ChordResult['kind'], string> = {
  found: 'Songle · Estimated chords', missing: 'No chords found for this track.',
  empty: 'No chords found for this track.', invalid: 'Could not load chords. Try again.',
  unavailable: 'Could not load chords. Try again.',
};

function piano(chord: string): HTMLElement {
  const notes = pianoNotes(chord);
  if (!notes) return element('p', 'Diagram unavailable');
  const keyboard = element('div', '');
  keyboard.className = 'chord-piano';
  keyboard.setAttribute('aria-hidden', 'true');
  for (const note of pianoKeys) {
    const key = element('span', '');
    if (note.includes('♯')) key.className = 'black-key';
    if (notes.includes(note)) key.dataset.played = 'true';
    keyboard.append(key);
  }
  const diagram = element('div', '');
  diagram.append(keyboard, element('p', notes.join(' · ')));
  return diagram;
}

function guitar(chord: string): HTMLElement {
  const frets = guitarFrets(chord);
  if (!frets) return element('p', 'Diagram unavailable');
  const base = Math.max(1, Math.max(...frets) - 3);
  const grid = element('div', '');
  grid.className = 'chord-guitar';
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `Low E to high E: ${frets.map(fret => fret < 0 ? 'muted' : fret || 'open').join(', ')}`);
  for (const fret of frets) grid.append(element('span', fret < 0 ? '×' : fret === 0 ? '○' : ' '));
  for (let row = base; row < base + 4; row++) {
    for (const fret of frets) {
      grid.append(element('span', fret === row ? '●' : ''));
    }
  }
  const diagram = element('div', '');
  diagram.append(grid, element('p', `Fret ${base} · E A D G B E`));
  return diagram;
}

export function mountChords(root: HTMLElement) {
  const details = root as HTMLDetailsElement;
  const status = root.querySelector('#chords-status')!;
  const content = root.querySelector<HTMLElement>('#chords-content')!;
  const progression = root.querySelector<HTMLElement>('#chord-progression')!;
  const current = root.querySelector('#chord-current')!;
  const next = root.querySelector('#chord-next')!;
  const diagrams = root.querySelector('#chord-diagrams')!;
  const retry = root.querySelector<HTMLButtonElement>('#chords-retry')!;
  let playback: PlayerPlayback | null = null;
  let captureId: string | undefined;
  let livePort: chrome.runtime.Port | undefined;
  let liveUnavailable = false;
  let outputDelay = 0;
  const liveTimeline = new LiveChordTimeline();
  let offset = 0;
  let events: ChordEvent[] | undefined;
  let buttons: HTMLElement[] = [];
  let selected: number | undefined;
  let highlighted = -1;
  let drawn = '';
  const session = new ChordSession(id => chrome.runtime.sendMessage({ target: 'chords', videoId: id }), render);

  const youtubePlayback = () => playback && 'videoId' in playback ? playback : null;
  const open = () => details.open && !document.hidden && !details.closest('[hidden]');

  function disconnectLive(): void {
    const port = livePort;
    livePort = undefined;
    port?.disconnect();
    liveTimeline.clear();
    liveUnavailable = false;
  }

  function connectLive(sessionId: string): void {
    const port = chrome.runtime.connect({ name: liveChordPort + sessionId });
    livePort = port;
    port.onMessage.addListener((sample: LiveChordSample) => {
      if (livePort !== port) return;
      outputDelay = sample.outputDelay;
      liveTimeline.update(sample);
      render();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (livePort !== port) return;
      disconnectLive();
      liveUnavailable = true;
      render();
    });
  }

  function showDiagram(chord?: string): void {
    if ((chord ?? '') === drawn) return;
    drawn = chord ?? '';
    diagrams.replaceChildren();
    if (chord) diagrams.append(element('h3', chord), element('h4', 'Guitar'), guitar(chord), element('h4', 'Piano'), piano(chord));
  }

  function render(): void {
    const result = session.result;
    const youtube = youtubePlayback();
    const live = Boolean(captureId && !youtube);
    const visible = Boolean(captureId && (live || (youtube && !youtube.ad && Number.isFinite(youtube.song.duration) && youtube.song.duration > 0)));
    const found = live ? liveTimeline.events : result?.kind === 'found' ? result.events : undefined;
    const position = live ? chordPositionAt(liveTimeline.events, (performance.timeOrigin + performance.now()) / 1000 - outputDelay)
      : found && youtube ? chordPosition(found, youtube, offset) : { current: -1, next: -1 };
    retry.hidden = !visible || (live ? !liveUnavailable : result?.kind !== 'unavailable' && result?.kind !== 'invalid');
    let message = 'Select a playing tab with the MoodShift icon.';
    if (live) {
      if (liveUnavailable) message = 'Could not start live chords. Try again.';
      else message = position.current >= 0 ? 'Live chord estimates' : 'Listening for chords…';
    } else if (youtube?.ad) message = 'Chords will resume after the ad.';
    else if (youtube) message = visible ? (result ? songleStatus[result.kind] : 'Finding chords…') : 'Chords will appear when the track starts.';
    if (status.textContent !== message) status.textContent = message;

    content.hidden = !visible || !found?.length;
    if (found !== events) {
      const pinned = live && selected !== undefined ? events?.[selected]?.startTime : undefined;
      const pinnedIndex = pinned === undefined ? -1 : (found?.findIndex(event => event.startTime === pinned) ?? -1);
      const hadFocus = pinnedIndex >= 0 && progression.contains(document.activeElement);
      events = found;
      selected = pinnedIndex < 0 ? undefined : pinnedIndex;
      highlighted = -1;
      buttons = (events ?? []).map(({ chord, startTime }, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = chord;
        button.setAttribute('aria-label', live ? `Detected chord ${chord}` : `${chord} at ${startTime.toFixed(2)} seconds`);
        button.addEventListener('click', () => {
          selected = selected === index ? undefined : index;
          render();
        });
        return button;
      });
      progression.replaceChildren(...buttons);
      if (hadFocus) buttons[pinnedIndex]?.focus({ preventScroll: true });
    }
    if (!found || !visible) {
      showDiagram();
      return;
    }
    if (highlighted !== position.current) {
      buttons[highlighted]?.removeAttribute('aria-current');
      highlighted = position.current;
      const active = buttons[highlighted];
      if (active) {
        active.setAttribute('aria-current', 'true');
        centerActive();
      }
    }
    current.textContent = found[position.current]?.chord ?? '—';
    next.textContent = found[position.next]?.chord ?? '—';
    const previous = progression.querySelector('[aria-pressed="true"]');
    previous?.setAttribute('aria-pressed', 'false');
    if (selected !== undefined) buttons[selected].setAttribute('aria-pressed', 'true');
    showDiagram(found[selected ?? position.current]?.chord);
  }

  function centerActive(): void {
    const active = buttons[highlighted];
    if (active && selected === undefined && progression.clientWidth) {
      progression.scrollLeft = active.offsetLeft - (progression.clientWidth - active.clientWidth) / 2;
    }
  }

  new ResizeObserver(centerActive).observe(progression);

  function sync(): void {
    const active = open();
    const youtube = youtubePlayback();
    session.setPlayback(active ? youtube : null);
    if (!active || !captureId || youtube) disconnectLive();
    else if (!livePort && !liveUnavailable) connectLive(captureId);
    if (active) render();
  }
  let displayReady = false;
  observeDisplay(settings => { details.open = settings.chordsOpen; displayReady = true; sync(); });
  details.addEventListener('toggle', () => {
    sync();
    if (displayReady) void setDisplay('chords.open', details.open).catch(() => undefined);
  });
  const settings = details.closest('#settings-panel');
  if (settings) new MutationObserver(sync).observe(settings, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', sync);
  retry.addEventListener('click', () => {
    if (youtubePlayback()) session.retry();
    else { liveUnavailable = false; sync(); }
  });
  return {
    setCapture(id?: string): void {
      if (captureId === id) return;
      disconnectLive();
      captureId = id;
      playback = null;
      sync();
    },
    setPlayback(update: PlayerPlayback | null, timingOffset: number) {
      if (livePort && playbackKey(update) !== playbackKey(playback)) liveTimeline.clear();
      playback = update;
      offset = timingOffset;
      sync();
    },
  };
}
