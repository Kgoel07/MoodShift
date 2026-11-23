import { homeSectionKeys, homeSections, readHomeLayout, type HomeSection } from './shared/home-layout';
import { observeDisplay, setDisplay } from './display-client';

const tabKey = 'moodshiftPanelTab';

export function mountPanelTabs(): void {
  const names = ['home', 'settings'] as const;
  const tabs = names.map(name => document.querySelector<HTMLButtonElement>(`#${name}-tab`)!);
  const panels = names.map(name => document.querySelector<HTMLElement>(`#${name}-panel`)!);
  const controls = document.querySelector('#home-layout-controls')!;
  const notice = document.querySelector('#home-layout-status')!;
  let layout = readHomeLayout(undefined);
  const pending = new Map<HomeSection, { checked: boolean }>();
  let selected = 0;
  const sections = homeSectionKeys.map(key => {
    const home = document.querySelector<HTMLElement>(`#home-${key}`)!;
    const settings = document.querySelector<HTMLElement>(`#settings-${key}`)!;
    const element = settings.firstElementChild!;
    const label = document.createElement('label');
    label.className = 'home-option';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.dataset.homeSection = key;
    toggle.disabled = true;
    label.append(homeSections[key].label, toggle);
    controls.append(label);
    toggle.addEventListener('change', () => {
      const edit = { checked: toggle.checked };
      pending.set(key, edit);
      updateSections();
      void setDisplay(`home.${key}`, edit.checked).then(() => {
        layout[key] = edit.checked;
        notice.textContent = '';
      }, () => { notice.textContent = 'Couldn’t save the Home layout. Please try again.'; }).finally(() => {
        if (pending.get(key) === edit) pending.delete(key);
        updateSections();
      });
    });
    return { key, home, settings, element, toggle };
  });

  function updateSections(): void {
    for (const { key, home, settings, element, toggle } of sections) {
      const visible = pending.get(key)?.checked ?? layout[key];
      const destination = selected === 0 && visible ? home : settings;
      if (element.parentElement !== destination) destination.append(element);
      home.hidden = destination !== home;
      toggle.checked = visible;
    }
  }

  function select(index: number, focus = false): void {
    selected = index;
    tabs.forEach((tab, current) => {
      const selected = current === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[current].hidden = !selected;
    });
    updateSections();
    localStorage.setItem(tabKey, names[index]);
    if (focus) tabs[index].focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      const next = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    });
  });
  select(['advanced', 'settings'].includes(localStorage.getItem(tabKey) ?? '') ? 1 : 0);
  observeDisplay(settings => {
    layout = settings.home;
    updateSections();
    for (const { toggle } of sections) toggle.disabled = false;
  }, () => { notice.textContent = 'Couldn’t load the saved Home layout.'; });
}
