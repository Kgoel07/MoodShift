const tabKey = 'moodshiftPanelTab';

export function mountPanelTabs(): void {
  const names = ['home', 'advanced'] as const;
  const tabs = names.map(name => document.querySelector<HTMLButtonElement>(`#${name}-tab`)!);
  const panels = names.map(name => document.querySelector<HTMLElement>(`#${name}-panel`)!);
  const sharedControls = [
    { element: document.querySelector('#preset-library')!, slots: names.map(name => document.querySelector(`#${name}-presets`)!) },
    { element: document.querySelector('#stem-controls')!, slots: names.map(name => document.querySelector(`#${name}-stems`)!) },
  ];

  function select(index: number, focus = false): void {
    tabs.forEach((tab, current) => {
      const selected = current === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[current].hidden = !selected;
    });
    for (const { element, slots } of sharedControls) {
      if (element.parentElement !== slots[index]) slots[index].append(element);
    }
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
  select(localStorage.getItem(tabKey) === 'advanced' ? 1 : 0);
}
