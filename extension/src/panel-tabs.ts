import { homeLayoutKey, homeSectionKeys, homeSections, readHomeLayout } from './shared/home-layout';

const tabKey = 'moodshiftPanelTab';

export function mountPanelTabs(): void {
  const names = ['home', 'settings'] as const;
  const tabs = names.map(name => document.querySelector<HTMLButtonElement>(`#${name}-tab`)!);
  const panels = names.map(name => document.querySelector<HTMLElement>(`#${name}-panel`)!);
  const controls = document.querySelector('#home-layout-controls')!;
  const notice = document.querySelector('#home-layout-status')!;
  let layout = readHomeLayout(undefined);
  let selected = 0;
  let save = Promise.resolve();
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
      layout = { ...layout, [key]: toggle.checked };
      updateSections();
      const pending = layout;
      save = save.then(() => chrome.storage.local.set({ [homeLayoutKey]: pending }))
        .then(() => { notice.textContent = ''; })
        .catch(() => { notice.textContent = 'Couldn’t save the Home layout. Please try again.'; });
    });
    return { key, home, settings, element, toggle };
  });

  function updateSections(): void {
    for (const { key, home, settings, element, toggle } of sections) {
      const destination = selected === 0 && layout[key] ? home : settings;
      if (element.parentElement !== destination) destination.append(element);
      home.hidden = destination !== home;
      toggle.checked = layout[key];
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
  void chrome.storage.local.get(homeLayoutKey).then(values => {
    layout = readHomeLayout(values[homeLayoutKey]);
  }).catch(() => { notice.textContent = 'Couldn’t load the saved Home layout.'; }).finally(() => {
    updateSections();
    for (const { toggle } of sections) toggle.disabled = false;
  });
}
