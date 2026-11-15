"use strict";
(() => {
  // extension/src/shared/effects.ts
  var effectSpecs = {
    bassDb: { label: "Bass shelf", min: -12, max: 8, neutral: 0, step: 0.1, unit: "dB" },
    trebleDb: { label: "Treble shelf", min: -12, max: 8, neutral: 0, step: 0.1, unit: "dB" },
    highpassHz: { label: "High-pass", min: 20, max: 1500, neutral: 20, step: 1, unit: "Hz" },
    lowpassHz: { label: "Low-pass", min: 600, max: 2e4, neutral: 2e4, step: 1, unit: "Hz" },
    reverbMix: { label: "Reverb", min: 0, max: 0.55, neutral: 0, step: 0.01, unit: "%" },
    delayMs: { label: "Echo time", min: 0, max: 500, neutral: 0, step: 1, unit: "ms" },
    delayMix: { label: "Echo mix", min: 0, max: 0.35, neutral: 0, step: 0.01, unit: "%" },
    delayFeedback: { label: "Echo feedback", min: 0, max: 0.4, neutral: 0, step: 0.01, unit: "%" },
    distortion: { label: "Distortion", min: 0, max: 0.5, neutral: 0, step: 0.01, unit: "%" },
    outputGainDb: { label: "Output gain", min: -12, max: 3, neutral: 0, step: 0.1, unit: "dB" }
  };
  var effectKeys = Object.keys(effectSpecs);
  var neutralEffects = Object.freeze(
    Object.fromEntries(effectKeys.map((key) => [key, effectSpecs[key].neutral]))
  );
  function clampPatch(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Expected an object of effect values.");
    }
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(effectSpecs, key)) throw new Error("Unknown effect parameter.");
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Effect values must be finite numbers.");
      const effect = key;
      const { min, max } = effectSpecs[effect];
      patch[effect] = Math.max(min, Math.min(max, value));
    }
    return patch;
  }
  var presets = {
    Dreamy: Object.freeze({ ...neutralEffects, reverbMix: 0.33, trebleDb: -2 }),
    Warm: Object.freeze({ ...neutralEffects, bassDb: 2, trebleDb: -3 }),
    Underwater: Object.freeze({ ...neutralEffects, lowpassHz: 1e3 }),
    "Bass Boost": Object.freeze({ ...neutralEffects, bassDb: 5 }),
    "Clear Voice": Object.freeze({ ...neutralEffects, highpassHz: 100, bassDb: -2, trebleDb: 2 })
  };

  // extension/src/shared/messages.ts
  var meterChannel = "moodshift-meter";
  function toWorker(command2) {
    return chrome.runtime.sendMessage({ ...command2, target: "worker" });
  }

  // extension/src/shared/types.ts
  var stemModes = ["full", "instrumental", "vocals"];
  var silentFeatures = Object.freeze({
    rms: 0,
    bassEnergy: 0,
    midEnergy: 0,
    trebleEnergy: 0,
    brightness: 0,
    isSilent: true
  });
  function directStemIntent(prompt) {
    const phrase = prompt.trim().toLowerCase().replace(/[.!?]+$/, "").replaceAll("-only", " only").replace(/^please\s+/, "").replace(/^(?:just\s+)?(?:play|give me)\s+/, "").replace(/^(?:just|only)\s+/, "").replace(/^the\s+/, "");
    if (/^(?:instrumental(?: only)?|remove (?:the )?vocals)$/.test(phrase)) return "instrumental";
    if (/^(?:vocals(?: only)?|isolate (?:the )?vocals)$/.test(phrase)) return "vocals";
    if (/^(?:back to (?:the )?)?full (?:mix|song)$/.test(phrase)) return "full";
    if (/^(?:underlying )?(?:beat|drums|bass)(?: only)?$/.test(phrase)) return "unsupported";
  }
  function plainText(value, max) {
    if (typeof value !== "string" || value.length > max) throw new Error("Invalid interpretation text.");
    const text = value.replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Empty interpretation text.");
    return text;
  }
  function parseInterpretation(input, current) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid interpretation response.");
    }
    const { mode, patch: rawPatch, summary, unsupported, stemMode } = input;
    if (Object.keys(input).some((key) => !["mode", "patch", "summary", "unsupported", "stemMode"].includes(key)) || mode !== "patch" && mode !== "reset" && mode !== "unsupported") {
      throw new Error("Invalid interpretation mode or fields.");
    }
    if (stemMode !== void 0 && (mode === "unsupported" || !stemModes.includes(stemMode))) {
      throw new Error("Invalid stem request.");
    }
    if (!Array.isArray(unsupported) || unsupported.length > 5) throw new Error("Invalid unsupported operations.");
    const notices = unsupported.map((item) => plainText(item, 100));
    const validated = clampPatch(rawPatch);
    if (mode !== "patch" && Object.keys(validated).length) throw new Error("Unexpected patch for this mode.");
    if (mode === "unsupported" && notices.length === 0) throw new Error("Missing unsupported operation.");
    const patch = {};
    for (const key of effectKeys) {
      const value = validated[key];
      if (value !== void 0 && value !== current[key]) patch[key] = value;
    }
    const result = { mode, patch, summary: plainText(summary, 240), unsupported: notices };
    if (stemMode !== void 0) result.stemMode = stemMode;
    return result;
  }

  // extension/src/shared/stem-pcm.ts
  var stemDelaySeconds = 2.8;

  // extension/src/sidepanel.ts
  var statusLabel = document.querySelector("#status");
  var stopButton = document.querySelector("#stop");
  var meter = document.querySelector("#meter");
  var inputStatus = document.querySelector("#input-status");
  var feedback = document.querySelector("#feedback");
  var controls = document.querySelector("#controls");
  var presetGroup = document.querySelector("#presets");
  var monitorButtons = [...document.querySelectorAll("[data-mode]")];
  var stemButtons = [...document.querySelectorAll("[data-stem]")];
  var stemLabel = document.querySelector("#stem-status");
  var form = document.querySelector("#interpret");
  var promptInput = document.querySelector("#prompt");
  var applyButton = document.querySelector("#apply");
  var status = { phase: "ready" };
  var refreshId = 0;
  var commandId = 0;
  var stopping = false;
  var queuedEdits = {};
  var editTimer;
  var commandPending = false;
  var interpretation;
  function updateApply() {
    applyButton.disabled = status.phase !== "capturing" || stopping || commandPending || interpretation !== void 0 || Object.keys(queuedEdits).length > 0 || !promptInput.value.trim();
  }
  function cancelInterpretation() {
    interpretation?.controller.abort();
    interpretation = void 0;
    updateApply();
  }
  function renderMeter(features) {
    const capture = status.phase === "capturing" ? status : void 0;
    meter.value = capture && !capture.session.muted && !capture.outputPaused ? Math.sqrt(features.rms) : 0;
    inputStatus.textContent = capture?.outputPaused ? "Audio output paused. Click MoodShift on the source tab to retry." : capture?.session.muted ? "Source tab muted." : capture && features.isSilent ? "Paused or silent input." : "";
  }
  function displayValue(value, unit) {
    if (unit === "%") return `${Math.round(value * 100)}%`;
    return `${Number(value.toFixed(1))} ${unit}`;
  }
  var sliders = effectKeys.map((key) => {
    const spec = effectSpecs[key];
    const label = document.createElement("label");
    const text = document.createElement("span");
    const value = document.createElement("output");
    const input = document.createElement("input");
    text.textContent = spec.label;
    input.id = `effect-${key}`;
    value.htmlFor = input.id;
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    label.append(text, value, input);
    controls.append(label);
    input.addEventListener("input", () => {
      cancelInterpretation();
      queuedEdits[key] = input.valueAsNumber;
      updateApply();
      value.textContent = displayValue(input.valueAsNumber, spec.unit);
      clearTimeout(editTimer);
      editTimer = setTimeout(flushEdits, 45);
    });
    input.addEventListener("change", flushEdits);
    return { key, input, value };
  });
  for (const [name, patch] of [...Object.entries(presets), ["Reset", neutralEffects]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      clearEdits();
      applyLocal(patch);
    });
    presetGroup.append(button);
  }
  function clearEdits() {
    clearTimeout(editTimer);
    queuedEdits = {};
  }
  function flushEdits() {
    const patch = queuedEdits;
    clearEdits();
    if (Object.keys(patch).length > 0) applyLocal(patch);
  }
  function applyLocal(patch) {
    cancelInterpretation();
    if (status.phase === "capturing") void command({ type: "APPLY_EFFECTS", sessionId: status.session.id, patch });
  }
  for (const button of monitorButtons) {
    button.addEventListener("click", () => {
      if (status.phase !== "capturing") return;
      const monitor = button.dataset.mode;
      void command({ type: "SET_MONITOR", sessionId: status.session.id, monitor });
    });
  }
  for (const button of stemButtons) {
    button.addEventListener("click", () => {
      if (status.phase !== "capturing") return;
      cancelInterpretation();
      void command({ type: "SET_STEM", mode: button.dataset.stem, sessionId: status.session.id });
    });
  }
  function render(next) {
    const previousId = status.phase === "capturing" ? status.session.id : void 0;
    const nextId = next.phase === "capturing" ? next.session.id : void 0;
    if (previousId !== nextId) {
      clearEdits();
      commandId++;
      commandPending = false;
      cancelInterpretation();
      stopping = false;
      feedback.textContent = "";
    }
    status = next;
    updateApply();
    const enabled = next.phase === "capturing" && !stopping;
    stopButton.disabled = !enabled;
    controls.disabled = !enabled;
    for (const button of presetGroup.querySelectorAll("button")) button.disabled = !enabled;
    for (const button of monitorButtons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(button.dataset.mode === (next.phase === "capturing" ? next.monitor : "modified")));
    }
    const stem = next.phase === "capturing" ? next.stem : void 0;
    for (const button of stemButtons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(button.dataset.stem === (stem?.mode ?? "full")));
    }
    switch (stem?.phase) {
      case "loading":
        stemLabel.textContent = "Connecting to the local model\u2026";
        break;
      case "buffering":
        stemLabel.textContent = "Buffering stem audio\u2026";
        break;
      case "active":
        stemLabel.textContent = next.phase === "capturing" && next.monitor === "original" ? "Original \xB7 Live mix. Modified resumes the delayed stem." : `Active \xB7 Audio trails video by about ${stemDelaySeconds} s.`;
        break;
      case "unavailable":
        stemLabel.textContent = `Unavailable \xB7 ${stem.message}`;
        break;
      default:
        stemLabel.textContent = "";
    }
    const effects = next.phase === "capturing" ? next.effects : neutralEffects;
    for (const { key, input, value } of sliders) {
      const setting = queuedEdits[key] ?? effects[key];
      input.value = String(setting);
      value.textContent = displayValue(setting, effectSpecs[key].unit);
    }
    renderMeter(next.phase === "capturing" ? next.features : silentFeatures);
    switch (next.phase) {
      case "ready":
        statusLabel.textContent = "Ready \xB7 Click MoodShift on the tab you want to hear.";
        break;
      case "starting":
        statusLabel.textContent = `Capturing\u2026 \xB7 ${next.source.title}`;
        break;
      case "capturing":
        statusLabel.textContent = `Listening to this tab \xB7 ${next.session.title}`;
        break;
      case "error":
        statusLabel.textContent = `Error \xB7 ${next.message}`;
        break;
    }
  }
  async function command(message, detail = "", stemMode) {
    const id = ++commandId;
    commandPending = true;
    updateApply();
    refreshId++;
    if (message.type === "APPLY_EFFECTS" || message.type === "SET_STEM") feedback.textContent = "Applying\u2026";
    try {
      let reply = await toWorker(message);
      if (id !== commandId) return;
      if (!reply.ok) throw new Error(reply.message);
      if (message.type === "APPLY_EFFECTS" && stemMode && reply.status.phase === "capturing") {
        reply = await toWorker({
          type: "SET_STEM",
          mode: stemMode,
          sessionId: message.sessionId,
          baseRevision: reply.status.revision
        });
        if (id !== commandId) return;
        if (!reply.ok) {
          feedback.textContent = `Effects updated. Stem unavailable \xB7 ${reply.message}`;
          void refresh();
          return;
        }
      }
      refreshId++;
      render(reply.status);
      if ((message.type === "APPLY_EFFECTS" || message.type === "SET_STEM") && reply.status.phase === "capturing" && reply.status.session.id === message.sessionId) {
        feedback.textContent = detail ? `Applied \u2713 \xB7 ${detail}` : "Applied \u2713";
      }
    } catch (error) {
      if (id !== commandId) return;
      stopping = false;
      feedback.textContent = `Error \xB7 ${error instanceof Error ? error.message : String(error)}`;
      void refresh();
    } finally {
      if (id === commandId) {
        commandPending = false;
        updateApply();
      }
    }
  }
  async function refresh() {
    const id = ++refreshId;
    try {
      const reply = await toWorker({ type: "GET_STATUS" });
      if (id === refreshId) render(reply.ok ? reply.status : { phase: "error", message: reply.message });
    } catch {
      if (id === refreshId) render({ phase: "error", message: "Reopen MoodShift to reconnect." });
    }
  }
  stopButton.addEventListener("click", () => {
    if (status.phase !== "capturing") return;
    clearEdits();
    cancelInterpretation();
    stopping = true;
    render(status);
    void command({ type: "STOP", sessionId: status.session.id });
  });
  promptInput.addEventListener("input", updateApply);
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  var GeminiUnavailable = class extends Error {
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (applyButton.disabled || !prompt || prompt.length > 500 || status.phase !== "capturing") return;
    const { session, effects, revision, features, outputPaused } = status;
    const direct = directStemIntent(prompt);
    if (direct === "unsupported") {
      feedback.textContent = "Unsupported \xB7 Beat, drum and bass isolation require separate stems.";
      return;
    }
    if (direct) {
      await command({ type: "SET_STEM", sessionId: session.id, mode: direct });
      return;
    }
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    interpretation = request;
    updateApply();
    feedback.textContent = "Interpreting\u2026";
    const deadline = setTimeout(() => request.controller.abort(), 15e3);
    try {
      const response = await fetch("http://127.0.0.1:8787/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          currentEffects: effects,
          audioFeatures: session.muted || outputPaused ? silentFeatures : features
        }),
        signal: request.controller.signal
      });
      const body = await response.json();
      if (interpretation?.id !== request.id) return;
      if (!response.ok) {
        const detail2 = typeof body?.error === "string" ? body.error.slice(0, 240) : "Check the local proxy.";
        if (response.status === 504) throw new Error("Gemini timed out. Try again.");
        if (response.status >= 500 || response.status === 429) throw new GeminiUnavailable(detail2);
        throw new Error(detail2);
      }
      const result = parseInterpretation(body, effects);
      const detail = [result.summary, result.unsupported.length ? `Unsupported \xB7 ${result.unsupported.join(", ")}` : ""].filter(Boolean).join(" ");
      if (result.mode === "unsupported") {
        feedback.textContent = detail;
        return;
      }
      if (result.mode === "patch" && Object.keys(result.patch).length === 0) {
        if (result.stemMode) {
          await command({ type: "SET_STEM", sessionId: session.id, mode: result.stemMode, baseRevision: revision }, detail);
        } else feedback.textContent = detail;
        return;
      }
      await command({
        type: "APPLY_EFFECTS",
        sessionId: session.id,
        baseRevision: revision,
        patch: result.mode === "reset" ? neutralEffects : result.patch
      }, detail, result.stemMode);
    } catch (error) {
      if (interpretation?.id !== request.id) return;
      if (request.controller.signal.aborted) {
        feedback.textContent = "Error \xB7 Gemini timed out. Try again.";
      } else if (error instanceof TypeError || error instanceof GeminiUnavailable) {
        const detail = error instanceof GeminiUnavailable ? error.message : "Start the local proxy with npm run dev:server.";
        feedback.textContent = `Offline \xB7 Gemini unavailable. Presets and manual controls still work. ${detail}`;
      } else {
        feedback.textContent = `Error \xB7 ${error instanceof Error ? error.message : "Invalid Gemini reply."}`;
      }
    } finally {
      clearTimeout(deadline);
      if (interpretation?.id === request.id) interpretation = void 0;
      updateApply();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target === "panel" && message.type === "STATUS_CHANGED") void refresh();
  });
  var meterUpdates = new BroadcastChannel(meterChannel);
  meterUpdates.addEventListener("message", (event) => {
    if (status.phase === "capturing" && status.session.id === event.data.sessionId) {
      status.features = event.data.features;
      renderMeter(event.data.features);
    }
  });
  void refresh();
})();
