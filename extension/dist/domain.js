"use strict";
(() => {
  // extension/src/shared/equalizer.ts
  var eqRange = { minHz: 20, maxHz: 2e4, minGain: -12, maxGain: 12, minQ: 0.3, maxQ: 12 };
  var defaultBands = [
    { id: "sub", frequency: 60, name: "Sub Bass" },
    { id: "bass", frequency: 170, name: "Bass" },
    { id: "low-mid", frequency: 400, name: "Low Mids" },
    { id: "mid", frequency: 1e3, name: "Mids" },
    { id: "high-mid", frequency: 3e3, name: "High Mids" },
    { id: "treble", frequency: 1e4, name: "Treble" }
  ];
  var customBandLimit = 12;
  var baseIds = new Set(defaultBands.map((band) => band.id));
  var uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  var customBand = new RegExp(`^point:${uuid}$`);
  var customEqPreset = new RegExp(`^eq:${uuid}$`);
  var eqPresets = {
    balanced: { name: "Balanced", gains: [0, 0, 0, 0, 0, 0] },
    bass: { name: "Bass Boost", gains: [5, 4, 1, -1, 0, 0] },
    vocal: { name: "Vocal Clarity", gains: [-3, -2, -1, 2, 4, 1] },
    warm: { name: "Warm", gains: [1, 3, 2, 0, -2, -2] },
    bright: { name: "Bright", gains: [-1, -1, -1, 0, 3, 5] }
  };
  function isDefaultBand(id) {
    return baseIds.has(id);
  }
  function builtInBands(id) {
    return defaultBands.map(({ id: bandId, frequency }, i) => ({ id: bandId, frequency, gain: eqPresets[id].gains[i], q: 1 }));
  }
  function defaultEqualizer() {
    return { enabled: true, preset: "balanced", bands: builtInBands("balanced") };
  }
  function limit(value, min, max, digits) {
    if (!Number.isFinite(value)) throw new Error("Enter a valid frequency, gain, or bandwidth.");
    return Number(Math.min(max, Math.max(min, value)).toFixed(digits));
  }
  function sanitizeBand(input) {
    if (!input || typeof input.id !== "string" || !isDefaultBand(input.id) && !customBand.test(input.id)) {
      throw new Error("This EQ point is invalid.");
    }
    const { minHz, maxHz, minGain, maxGain, minQ, maxQ } = eqRange;
    return {
      id: input.id,
      frequency: limit(input.frequency, minHz, maxHz, 0),
      gain: limit(input.gain, minGain, maxGain, 1),
      q: limit(input.q, minQ, maxQ, 2)
    };
  }
  function validateBands(input) {
    if (!Array.isArray(input) || input.length < defaultBands.length || input.length > defaultBands.length + customBandLimit) {
      throw new Error("This EQ has an invalid number of bands.");
    }
    const bands = input.map(sanitizeBand);
    const byId = new Map(bands.map((band) => [band.id, band]));
    if (byId.size !== bands.length || defaultBands.some((band) => !byId.has(band.id))) {
      throw new Error("This EQ is missing a default band or has duplicate points.");
    }
    return [...defaultBands.map((band) => byId.get(band.id)), ...bands.filter((band) => !isDefaultBand(band.id))];
  }
  function validateEq(input) {
    const eq = input;
    if (!eq || typeof eq.enabled !== "boolean" || eq.preset !== null && (typeof eq.preset !== "string" || !Object.hasOwn(eqPresets, eq.preset) && !customEqPreset.test(eq.preset))) throw new Error("Invalid equalizer settings.");
    return { enabled: eq.enabled, preset: eq.preset, bands: validateBands(eq.bands) };
  }
  function changeEq(current, edit) {
    switch (edit.kind) {
      case "eq-enabled":
        return validateEq({ ...current, enabled: edit.enabled });
      case "eq-reset":
        return { ...defaultEqualizer(), enabled: current.enabled };
      case "eq-preset": {
        const bands = Object.hasOwn(eqPresets, edit.preset) ? builtInBands(edit.preset) : edit.bands;
        return validateEq({ enabled: true, preset: edit.preset, bands });
      }
      case "eq-forget":
        return current.preset === edit.preset ? { ...current, preset: null } : current;
      case "eq-band": {
        const previous = current.bands.find((band) => band.id === edit.id);
        if (!previous) throw new Error("That EQ point is no longer available.");
        const next = sanitizeBand({ ...previous, ...edit.patch, id: previous.id });
        if (next.frequency === previous.frequency && next.gain === previous.gain && next.q === previous.q) return current;
        return { ...current, preset: null, bands: current.bands.map((band) => band === previous ? next : band) };
      }
      case "eq-add": {
        const point = sanitizeBand(edit.point);
        if (isDefaultBand(point.id)) throw new Error("Choose a new EQ point.");
        if (current.bands.some((band) => band.id === point.id)) return current;
        return validateEq({ ...current, preset: null, bands: [...current.bands, point] });
      }
      case "eq-remove":
        if (isDefaultBand(edit.id)) throw new Error("The six default bands can be reset in the equalizer.");
        return { ...current, preset: null, bands: current.bands.filter((band) => band.id !== edit.id) };
      default:
        throw new Error("Unknown equalizer action.");
    }
  }

  // extension/src/shared/eq-response.ts
  var spectrumSize = 128;
  var logSpan = Math.log(eqRange.maxHz / eqRange.minHz);
  var frequencyAt = (position) => eqRange.minHz * Math.exp(position * logSpan);
  var frequencyPosition = (frequency) => Math.log(frequency / eqRange.minHz) / logSpan;
  var effectiveFrequency = (frequency, rate) => Math.min(frequency, rate * 0.499);
  function equalizerResponse(eq, rate) {
    const bands = eq.enabled ? eq.bands.filter((band) => band.gain !== 0) : [];
    const coefficients = bands.map(({ frequency, gain, q }) => {
      const omega = 2 * Math.PI * effectiveFrequency(frequency, rate) / rate;
      const alpha = Math.sin(omega) / (2 * q);
      const amplitude = 10 ** (gain / 40);
      return { center: Math.cos(omega), numerator: alpha * amplitude, denominator: alpha / amplitude };
    });
    const rawDb = (hz) => {
      const omega = 2 * Math.PI * effectiveFrequency(hz, rate) / rate;
      const cosine = Math.cos(omega), sine = Math.sin(omega);
      let db = 0;
      for (const { center, numerator, denominator } of coefficients) {
        const realSquared = (cosine - center) ** 2;
        db += 10 * Math.log10((realSquared + (numerator * sine) ** 2) / (realSquared + (denominator * sine) ** 2));
      }
      return db;
    };
    let peak = 0;
    if (bands.some((band) => band.gain > 0)) {
      for (let i = 0; i <= 240; i++) peak = Math.max(peak, rawDb(frequencyAt(i / 240)));
      for (const band of bands) peak = Math.max(peak, rawDb(band.frequency));
    }
    const trimDb = Math.min(0, 12 - peak);
    return { trimDb, gainDb: (hz) => rawDb(hz) + trimDb };
  }

  // extension/src/eq-chart.ts
  function frequencyLabel(hz) {
    return hz >= 1e3 ? `${Number((hz / 1e3).toFixed(1))}k` : String(Math.round(hz));
  }
  var gainLabel = (gain) => `${gain > 0 ? "+" : ""}${gain.toFixed(1)}`;
  var gainSpan = eqRange.maxGain - eqRange.minGain;
  var clampUnit = (n) => Math.max(0, Math.min(1, n));
  var points = 256;
  var EqChart = class {
    constructor(canvas, compact, onResize) {
      this.canvas = canvas;
      this.compact = compact;
      this.context = this.canvas.getContext("2d");
      this.colors = getComputedStyle(this.canvas);
      this.accent = this.colors.getPropertyValue("--accent").trim();
      this.muted = this.colors.getPropertyValue("--muted").trim();
      this.line = this.colors.getPropertyValue("--line").trim();
      this.curve = new Float32Array(points + 1);
      this.width = 0;
      this.height = 0;
      this.ratio = 1;
      this.rate = 48e3;
      this.trimDb = 0;
      new ResizeObserver(([{ contentRect }]) => {
        this.width = contentRect.width;
        this.height = contentRect.height;
        this.ratio = Math.min(devicePixelRatio, 2);
        canvas.width = Math.round(this.width * this.ratio);
        canvas.height = Math.round(this.height * this.ratio);
        this.draw();
        onResize?.();
      }).observe(canvas);
    }
    get left() {
      return this.compact ? 26 : 48;
    }
    get top() {
      return this.compact ? 8 : 18;
    }
    get graphWidth() {
      return Math.max(1, this.width - this.left - (this.compact ? 9 : 22));
    }
    get graphHeight() {
      return Math.max(1, this.height - this.top - (this.compact ? 18 : 30));
    }
    y(gain) {
      return this.top + (eqRange.maxGain - gain) / gainSpan * this.graphHeight;
    }
    position(band) {
      return { x: this.left + frequencyPosition(band.frequency) * this.graphWidth, y: this.y(band.gain) };
    }
    editAt(clientX, clientY, clamp = true) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (clientX - rect.x - this.left) / this.graphWidth;
      const y = (clientY - rect.y - this.top) / this.graphHeight;
      if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return;
      return { frequency: Math.round(frequencyAt(clampUnit(x))), gain: Number((eqRange.maxGain - gainSpan * clampUnit(y)).toFixed(1)) };
    }
    setEq(eq, rate = 48e3) {
      if (this.eq === eq && this.rate === rate) return;
      this.eq = eq;
      this.rate = rate;
      const { gainDb, trimDb } = equalizerResponse(eq, rate);
      this.trimDb = trimDb;
      for (let i = 0; i <= points; i++) this.curve[i] = gainDb(frequencyAt(i / points));
      this.draw();
    }
    setSpectrum(data) {
      this.spectrum = data;
      this.draw();
    }
    draw() {
      const { context: ctx, left, top, graphHeight: height, graphWidth: width } = this;
      if (!this.width || !this.height) return;
      ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.font = `${this.compact ? 9 : 11}px system-ui, sans-serif`;
      ctx.strokeStyle = this.line;
      ctx.fillStyle = this.muted;
      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const db of this.compact ? [-12, 0, 12] : [-12, -6, 0, 6, 12]) {
        const y = this.y(db);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.fillText(`${db > 0 ? "+" : ""}${db}${this.compact ? "" : " dB"}`, left - 5, y);
      }
      ctx.textAlign = "center";
      const ticks = this.compact ? [60, 400, 3e3, 1e4] : [20, 60, 200, 600, 2e3, 6e3, 2e4];
      for (const hz of ticks) {
        const x = left + frequencyPosition(hz) * width;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
        ctx.stroke();
        ctx.fillText(frequencyLabel(hz), x, top + height + (this.compact ? 9 : 15));
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      if (this.spectrum?.length) {
        ctx.beginPath();
        ctx.moveTo(left, top + height);
        this.spectrum.forEach((level, i, values) => {
          const x = left + i / (values.length - 1) * width;
          const y = top + height * (1 - level / 255 * 0.86);
          ctx.lineTo(x, y);
        });
        ctx.lineTo(left + width, top + height);
        ctx.closePath();
        ctx.fillStyle = this.accent;
        ctx.globalAlpha = 0.17;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const frequency = frequencyAt(i / points);
        if (frequency > effectiveFrequency(frequency, this.rate)) break;
        const x = left + i / points * width, y = this.y(this.curve[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = this.compact ? 1.6 : 2;
      ctx.stroke();
      ctx.restore();
    }
  };

  // extension/src/eq-presets.ts
  var eqPresetsKey = "moodshiftEqPresets";
  var maxPresets = 30;
  function readEqPresets(input) {
    if (!Array.isArray(input)) return [];
    const result = /* @__PURE__ */ new Map();
    for (const row of input.slice(0, maxPresets)) {
      if (typeof row?.id !== "string" || !customEqPreset.test(row.id) || typeof row?.name !== "string" || !row.name.trim() || row.name.length > 48) continue;
      try {
        result.set(row.id, { id: row.id, name: row.name.trim(), bands: validateBands(row.bands) });
      } catch {
      }
    }
    return [...result.values()];
  }
  async function loadEqPresets() {
    return readEqPresets((await chrome.storage.local.get(eqPresetsKey))[eqPresetsKey]);
  }
  async function saveEqPreset(name, bands) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 48) throw new Error("Enter a name between 1 and 48 characters.");
    const preset = { id: `eq:${crypto.randomUUID()}`, name: trimmed, bands: validateBands(bands) };
    return navigator.locks.request(eqPresetsKey, async () => {
      const presets = await loadEqPresets();
      if (presets.some((row) => row.name.toLowerCase() === trimmed.toLowerCase())) throw new Error("An EQ preset already uses that name.");
      if (presets.length >= maxPresets) throw new Error("Delete an EQ preset before saving another.");
      await chrome.storage.local.set({ [eqPresetsKey]: [...presets, preset] });
      return preset;
    });
  }
  async function deleteEqPreset(id) {
    await navigator.locks.request(eqPresetsKey, async () => {
      const presets = await loadEqPresets();
      await chrome.storage.local.set({ [eqPresetsKey]: presets.filter((preset) => preset.id !== id) });
    });
  }

  // extension/src/eq-preset-controls.ts
  function mountEqPresetControls(root, client2, report2) {
    const select = root.querySelector("[data-eq-preset]");
    const form = root.querySelector("#eq-preset-form");
    const name = form?.querySelector("input");
    const remove2 = root.querySelector("#eq-preset-delete");
    let presets = [];
    let busy = false;
    function refreshSelection() {
      const { settings, ready } = client2.view;
      const id = settings.eq.preset ?? "";
      select.value = [...select.options].some((option) => option.value === id) ? id : "";
      select.disabled = busy || !ready;
      if (remove2) remove2.hidden = !presets.some((preset) => preset.id === select.value);
    }
    function drawPresets() {
      const custom = new Option("Custom curve", "");
      custom.disabled = true;
      select.replaceChildren(custom, ...Object.entries(eqPresets).map(([id, { name: name2 }]) => new Option(name2, id)));
      if (presets.length) {
        const saved = document.createElement("optgroup");
        saved.label = "Saved EQ presets";
        for (const preset of presets) saved.append(new Option(preset.name, preset.id));
        select.append(saved);
      }
      refreshSelection();
    }
    async function run(work) {
      if (busy) return;
      busy = true;
      refreshSelection();
      try {
        report2(await work());
      } catch (error) {
        report2(error instanceof Error ? error.message : "Couldn\u2019t update your EQ presets.");
      } finally {
        busy = false;
        refreshSelection();
      }
    }
    select.addEventListener("change", () => {
      const saved = presets.find((preset) => preset.id === select.value);
      client2.edit({ kind: "eq-preset", preset: select.value, ...saved ? { bands: saved.bands } : {} });
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!client2.view.ready || !name) return;
      void run(async () => {
        const preset = await saveEqPreset(name.value, client2.view.settings.eq.bands);
        name.value = "";
        presets = await loadEqPresets();
        drawPresets();
        return `Saved ${preset.name}.`;
      });
    });
    remove2?.addEventListener("click", () => {
      const id = select.value;
      if (!presets.some((preset) => preset.id === id)) return;
      void run(async () => {
        await deleteEqPreset(id);
        client2.edit({ kind: "eq-forget", preset: id });
        return "EQ preset deleted.";
      });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[eqPresetsKey]) return;
      presets = readEqPresets(changes[eqPresetsKey].newValue);
      drawPresets();
    });
    client2.subscribe(refreshSelection);
    drawPresets();
    void loadEqPresets().then((saved) => {
      presets = saved;
      drawPresets();
    }).catch(() => report2("Couldn\u2019t load your saved EQ presets."));
  }

  // extension/src/shared/messages.ts
  function toWorker(command) {
    return chrome.runtime.sendMessage({ ...command, target: "worker" });
  }

  // extension/src/shared/pitch.ts
  var pitchRange = { min: -6, max: 6, step: 0.1 };
  var defaultPitch = { enabled: false, semitones: 0 };
  function pitchSettings(input) {
    const pitch = input;
    if (!pitch || typeof pitch.enabled !== "boolean" || !Number.isFinite(pitch.semitones)) {
      throw new Error("Choose a valid pitch setting.");
    }
    const { min, max } = pitchRange;
    return { enabled: pitch.enabled, semitones: Math.round(Math.max(min, Math.min(max, pitch.semitones)) * 10) / 10 || 0 };
  }

  // extension/src/shared/tuning.ts
  var eqSpectrumPort = "moodshift-eq-spectrum";
  function defaultTuning() {
    return { pitch: { ...defaultPitch }, eq: defaultEqualizer() };
  }
  function changeTuning(current, edit) {
    if (!edit || typeof edit !== "object") throw new Error("Invalid pitch or EQ action.");
    if (edit.kind === "pitch") return { ...current, pitch: pitchSettings({ ...current.pitch, ...edit.patch }) };
    const eq = changeEq(current.eq, edit);
    return eq === current.eq ? current : { ...current, eq };
  }

  // extension/src/tuning-client.ts
  var sessionId = (status) => status.phase === "capturing" ? status.session.id : void 0;
  function mergeEdit(a, b) {
    if (a.kind === "pitch" && b.kind === "pitch") return { kind: "pitch", patch: { ...a.patch, ...b.patch } };
    if (a.kind === "eq-band" && b.kind === "eq-band" && a.id === b.id) return { ...b, patch: { ...a.patch, ...b.patch } };
  }
  var TuningClient = class {
    constructor(report2, editing = () => {
    }) {
      this.report = report2;
      this.editing = editing;
      this.listeners = /* @__PURE__ */ new Set();
      this.queue = [];
      this.current = { phase: "ready" };
      this.loaded = false;
      this.request = 0;
    }
    get busy() {
      return Boolean(this.queue.length || this.inFlight);
    }
    get view() {
      let settings = this.current.tuning ?? defaultTuning();
      const source = sessionId(this.current);
      for (const pending of [this.inFlight, ...this.queue]) {
        if (!pending || pending.sessionId !== source) continue;
        try {
          settings = changeTuning(settings, pending.action);
        } catch {
        }
      }
      return { settings, status: this.current, ready: this.loaded && this.current.phase !== "starting" };
    }
    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.view);
    }
    notify() {
      const view2 = this.view;
      for (const listener of this.listeners) listener(view2);
    }
    accept(status) {
      if (status.phase === "capturing" && this.current.phase === "capturing" && status.session.id === this.current.session.id && status.revision < this.current.revision) return;
      this.current = status;
      this.loaded = Boolean(status.tuning);
      this.notify();
    }
    async refresh() {
      const id = ++this.request;
      try {
        const reply = await toWorker({ type: "GET_STATUS" });
        if (id === this.request && reply.ok) this.accept(reply.status);
      } catch (error) {
        console.warn("MoodShift tuning status unavailable", error);
        if (id === this.request) this.report("Couldn\u2019t load audio settings. Reopen MoodShift to reconnect.");
      }
    }
    edit(action, scrub = false) {
      if (!this.view.ready) return;
      try {
        changeTuning(this.view.settings, action);
      } catch (error) {
        this.report(error instanceof Error ? error.message : "Couldn\u2019t edit this setting.");
        return;
      }
      this.editing();
      const source = sessionId(this.current);
      const tail = this.queue.at(-1);
      const merged = tail && tail.sessionId === source ? mergeEdit(tail.action, action) : void 0;
      if (merged) tail.action = merged;
      else this.queue.push({ sessionId: source, action });
      this.report("");
      this.notify();
      if (scrub) this.timer ??= setTimeout(() => {
        this.timer = void 0;
        void this.flush();
      }, 42);
      else {
        clearTimeout(this.timer);
        this.timer = void 0;
        void this.flush();
      }
    }
    async flush() {
      if (this.inFlight) return;
      while (this.queue.length && !this.timer) {
        const pending = this.queue.shift();
        if (pending.sessionId !== sessionId(this.current)) continue;
        this.inFlight = pending;
        let acknowledged;
        try {
          const reply = await toWorker({ type: "SET_TUNING", sessionId: pending.sessionId, edit: pending.action });
          if (!reply.ok) throw new Error(reply.message);
          acknowledged = reply.status;
        } catch (error) {
          console.warn("MoodShift tuning edit failed", error);
          this.report("Couldn\u2019t update this audio setting. Please try again.");
        } finally {
          this.inFlight = void 0;
        }
        if (acknowledged && pending.sessionId === sessionId(this.current)) this.accept(acknowledged);
        else {
          this.notify();
          void this.refresh();
        }
      }
    }
  };

  // extension/src/domain.ts
  var find = (selector) => document.querySelector(selector);
  var report = (message) => {
    find("#domain-status").textContent = message;
  };
  var client = new TuningClient(report);
  var plot = find("#domain-plot");
  var points2 = find("#domain-points");
  var chart = new EqChart(find("#domain-canvas"), false, positionPoints);
  var picker = find("#domain-band");
  var enabled = find("#domain-enabled");
  var remove = find("#point-delete");
  var add = find("#point-add");
  var inputs = { frequency: find("#point-frequency"), gain: find("#point-gain"), q: find("#point-q") };
  var knobs = /* @__PURE__ */ new Map();
  var reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  var view = client.view;
  var selected = defaultBands[0].id;
  var drag;
  var spectrum;
  function positionPoints() {
    for (const band of view.settings.eq.bands) {
      const button = knobs.get(band.id);
      if (!button) continue;
      const { x, y } = chart.position(band);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
    }
  }
  function selectPoint(id) {
    if (selected === id) return;
    selected = id;
    renderPointFields(true);
  }
  function renderPointFields(force = false) {
    const bands = view.settings.eq.bands;
    const band = bands.find((point) => point.id === selected) ?? bands[0];
    selected = band.id;
    picker.value = selected;
    for (const key of ["frequency", "gain", "q"]) {
      if (force || document.activeElement !== inputs[key]) inputs[key].value = String(band[key]);
    }
    for (const [id, button] of knobs) button.setAttribute("aria-pressed", String(id === selected));
    remove.disabled = isDefaultBand(selected);
    add.disabled = bands.length >= defaultBands.length + customBandLimit;
  }
  function syncSpectrum() {
    const shouldRun = view.status.phase === "capturing" && !document.hidden && !reducedMotion.matches;
    if (!shouldRun) {
      const previous = spectrum;
      spectrum = void 0;
      previous?.disconnect();
      chart.setSpectrum();
      return;
    }
    if (spectrum) return;
    const port = chrome.runtime.connect({ name: eqSpectrumPort });
    spectrum = port;
    port.onMessage.addListener((message) => {
      if (spectrum !== port || !Array.isArray(message) || message.length !== spectrumSize) return;
      chart.setSpectrum(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (spectrum === port) {
        spectrum = void 0;
        chart.setSpectrum();
      }
    });
  }
  function createPoint(id) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "eq-point";
    button.dataset.eqPoint = id;
    button.addEventListener("click", () => selectPoint(id));
    button.addEventListener("focus", () => selectPoint(id));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const band = view.settings.eq.bands.find((band2) => band2.id === id);
      if (!band) return;
      event.preventDefault();
      const patch = event.key === "ArrowUp" || event.key === "ArrowDown" ? { gain: band.gain + (event.key === "ArrowUp" ? 0.5 : -0.5) } : { frequency: band.frequency * (event.key === "ArrowRight" ? 1.06 : 1 / 1.06) };
      client.edit({ kind: "eq-band", id, patch });
    });
    points2.append(button);
    knobs.set(id, button);
    return button;
  }
  function render(next) {
    view = next;
    const { eq } = next.settings;
    const capture = next.status.phase === "capturing" ? next.status : void 0;
    find("#domain-source").textContent = capture?.session.title ?? "Start capture to hear your EQ";
    find("#domain-toolbar").disabled = !next.ready;
    find("#point-controls").disabled = !next.ready;
    enabled.checked = eq.enabled;
    chart.setEq(eq, capture?.audioTiming?.sampleRate);
    const trim = find("#eq-trim");
    trim.hidden = chart.trimDb >= -0.05;
    trim.textContent = `Automatic headroom ${chart.trimDb.toFixed(1)} dB`;
    for (const [id, button] of knobs) {
      if (eq.bands.some((band) => band.id === id)) continue;
      button.remove();
      knobs.delete(id);
    }
    let custom = 0;
    const options = [];
    for (const band of eq.bands) {
      const name = defaultBands.find((entry) => entry.id === band.id)?.name ?? `Custom ${++custom}`;
      options.push(new Option(`${name} \xB7 ${band.frequency} Hz`, band.id));
      const button = knobs.get(band.id) ?? createPoint(band.id);
      button.disabled = !next.ready;
      button.setAttribute("aria-label", `${name}, ${band.frequency} Hz, ${gainLabel(band.gain)} dB, Q ${band.q}`);
      button.title = `${name} \xB7 ${band.frequency} Hz \xB7 ${gainLabel(band.gain)} dB`;
    }
    if (options.length !== picker.options.length || options.some((option, i) => option.text !== picker.options[i]?.text || option.value !== picker.options[i]?.value)) picker.replaceChildren(...options);
    renderPointFields();
    positionPoints();
    syncSpectrum();
  }
  function addPoint(frequency, gain) {
    if (add.disabled) {
      report(`You can add up to ${customBandLimit} custom points.`);
      return;
    }
    const point = { id: `point:${crypto.randomUUID()}`, frequency, gain, q: 1 };
    client.edit({ kind: "eq-add", point });
    selectPoint(point.id);
    return point.id;
  }
  plot.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0 || !view.ready) return;
    const button = event.target.closest("[data-eq-point]");
    let id = button?.dataset.eqPoint;
    if (!id) {
      const value = chart.editAt(event.clientX, event.clientY, false);
      if (!value) return;
      id = addPoint(value.frequency, value.gain);
      if (!id) return;
    }
    selectPoint(id);
    const rect = button?.getBoundingClientRect();
    drag = {
      pointer: event.pointerId,
      point: id,
      xOffset: rect ? event.clientX - rect.x - rect.width / 2 : 0,
      yOffset: rect ? event.clientY - rect.y - rect.height / 2 : 0
    };
    plot.setPointerCapture(event.pointerId);
    knobs.get(id)?.focus({ preventScroll: true });
    event.preventDefault();
  });
  plot.addEventListener("pointermove", (event) => {
    if (drag?.pointer !== event.pointerId || !view.settings.eq.bands.some((band) => band.id === drag?.point)) return;
    drag.last = chart.editAt(event.clientX - drag.xOffset, event.clientY - drag.yOffset);
    if (drag.last) client.edit({ kind: "eq-band", id: drag.point, patch: drag.last }, true);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    plot.addEventListener(name, (event) => {
      if (drag?.pointer !== event.pointerId) return;
      const { last, point } = drag;
      drag = void 0;
      if (last && view.settings.eq.bands.some((band) => band.id === point)) client.edit({ kind: "eq-band", id: point, patch: last });
    });
  }
  for (const [property, input] of Object.entries(inputs)) {
    input.addEventListener("change", () => {
      if (Number.isFinite(input.valueAsNumber)) client.edit({ kind: "eq-band", id: selected, patch: { [property]: input.valueAsNumber } });
      renderPointFields(true);
    });
  }
  picker.addEventListener("change", () => selectPoint(picker.value));
  remove.addEventListener("click", () => client.edit({ kind: "eq-remove", id: selected }));
  add.addEventListener("click", () => {
    const id = addPoint(Math.round(Math.sqrt(eqRange.minHz * eqRange.maxHz)), 0);
    if (id) knobs.get(id)?.focus({ preventScroll: true });
  });
  enabled.addEventListener("change", () => client.edit({ kind: "eq-enabled", enabled: enabled.checked }));
  find("#domain-reset").addEventListener("click", () => client.edit({ kind: "eq-reset" }));
  find("#domain-close").addEventListener("click", () => window.close());
  document.addEventListener("visibilitychange", syncSpectrum);
  reducedMotion.addEventListener("change", syncSpectrum);
  window.addEventListener("pagehide", () => spectrum?.disconnect());
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target === "panel" && message.type === "STATUS_CHANGED") void client.refresh();
  });
  mountEqPresetControls(document.body, client, report);
  client.subscribe(render);
  void client.refresh();
})();
