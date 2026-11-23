import { rangeFill } from './shared/home-layout';

export function paintRange(input: HTMLInputElement): void {
  input.style.setProperty('--fill', `${rangeFill(input.valueAsNumber, Number(input.min), Number(input.max))}%`);
}
