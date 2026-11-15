import { ChordSession } from './chords-provider';
import { chordPosition, guitarFrets, pianoNotes, type ChordEvent } from './shared/chords';
import type { YouTubePlayback } from './shared/lyrics';

const pianoKeys = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const element = (tag: string, content: string) => {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
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
  let playback: YouTubePlayback | null = null;
  let offset = 0;
  let events: ChordEvent[] | undefined;
  let buttons: HTMLElement[] = [];
  let selected: number | undefined;
  let highlighted = -1;
  let drawn = '';
  const session = new ChordSession(id => chrome.runtime.sendMessage({ target: 'chords', videoId: id }), render);

  function showDiagram(chord?: string): void {
    if ((chord ?? '') === drawn) return;
    drawn = chord ?? '';
    diagrams.replaceChildren();
    if (chord) diagrams.append(element('h3', chord), element('h4', 'Guitar'), guitar(chord), element('h4', 'Piano'), piano(chord));
  }

  function render(): void {
    const result = session.result;
    const visible = playback && !playback.ad && Number.isFinite(playback.song.duration) && playback.song.duration > 0;
    retry.hidden = !visible || (result?.kind !== 'unavailable' && result?.kind !== 'invalid');
    const message = !playback ? 'Select a YouTube watch tab with the MoodShift icon.'
      : playback.ad ? 'Chords will resume after the ad.'
      : !visible ? 'A finite YouTube video is needed.'
      : !result ? 'Finding chords…'
      : result.kind === 'found' ? 'Songle · Estimated chords'
      : result.kind === 'missing' ? 'Songle has no chord data for this video.'
      : result.kind === 'empty' ? 'Songle returned an empty chord progression.'
      : result.kind === 'invalid' ? 'Could not read the Songle response.'
      : 'Songle is unavailable.';
    if (status.textContent !== message) status.textContent = message;

    const found = result?.kind === 'found' ? result.events : undefined;
    content.hidden = !visible || !found;
    if (found !== events) {
      events = found;
      selected = undefined;
      highlighted = -1;
      buttons = (events ?? []).map(({ chord, startTime }, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = chord;
        button.setAttribute('aria-label', `${chord} at ${startTime.toFixed(2)} seconds`);
        button.addEventListener('click', () => {
          selected = selected === index ? undefined : index;
          render();
        });
        return button;
      });
      progression.replaceChildren(...buttons);
    }
    if (!found || !visible || !playback) {
      showDiagram();
      return;
    }
    const position = chordPosition(found, playback, offset);
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
    session.setPlayback(details.open ? playback : null);
    if (details.open) render();
  }
  details.addEventListener('toggle', sync);
  retry.addEventListener('click', () => session.retry());
  return {
    setPlayback(update: YouTubePlayback | null, timingOffset: number) {
      playback = update;
      offset = timingOffset;
      sync();
    },
  };
}
