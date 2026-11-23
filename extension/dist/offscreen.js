"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

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
  function applyPatch(current, patch) {
    return { ...current, ...clampPatch(patch) };
  }
  var presets = {
    Dreamy: Object.freeze({ ...neutralEffects, reverbMix: 0.33, trebleDb: -2 }),
    Warm: Object.freeze({ ...neutralEffects, bassDb: 2, trebleDb: -3 }),
    Underwater: Object.freeze({ ...neutralEffects, lowpassHz: 1e3 }),
    "Bass Boost": Object.freeze({ ...neutralEffects, bassDb: 5 }),
    "Clear Voice": Object.freeze({ ...neutralEffects, highpassHz: 100, bassDb: -2, trebleDb: 2 })
  };

  // extension/src/shared/reverb.ts
  var reverbPresets = {
    dreamy: { label: "\u{1F319} Dreamy Reverb", amount: 0.28, duration: 2.4, preDelay: 0.012, toneHz: 3800 },
    hall: { label: "\u{1F3DB}\uFE0F Concert Hall", amount: 0.24, duration: 2.8, preDelay: 0.028, toneHz: 6500 },
    slowed: { label: "\u{1F327}\uFE0F Slowed + Reverb", amount: 0.34, duration: 3.4, preDelay: 0.018, toneHz: 2800 }
  };
  var reverbDuration = { min: 0.4, max: 4, step: 0.1 };
  var defaultReverb = Object.freeze({ preset: "dreamy", duration: 2.4, lastAmount: 0.28 });
  function bounded(value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Reverb values must be finite numbers.");
    return Math.max(min, Math.min(max, value));
  }
  function validateReverb(input) {
    const value = input;
    if (!value || typeof value !== "object" || !Object.hasOwn(reverbPresets, value.preset) || Object.keys(value).some((key) => !["preset", "duration", "lastAmount"].includes(key))) throw new Error("Invalid reverb settings.");
    return {
      preset: value.preset,
      duration: Math.round(bounded(value.duration, reverbDuration.min, reverbDuration.max) * 10) / 10,
      lastAmount: bounded(value.lastAmount, 0, effectSpecs.reverbMix.max)
    };
  }
  function changeReverb(current, mix, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid reverb change.");
    const patch = input;
    if (Object.keys(patch).some((key) => !["preset", "duration", "enabled", "amount"].includes(key)) || patch.enabled !== void 0 && typeof patch.enabled !== "boolean") throw new Error("Invalid reverb change.");
    let settings = { ...current };
    if (patch.preset !== void 0) {
      if (!Object.hasOwn(reverbPresets, patch.preset)) throw new Error("Unknown reverb preset.");
      const preset = reverbPresets[patch.preset];
      settings = { preset: patch.preset, duration: preset.duration, lastAmount: preset.amount };
      mix = preset.amount;
    }
    if (patch.duration !== void 0) settings.duration = patch.duration;
    if (patch.amount !== void 0) {
      mix = bounded(patch.amount, 0, effectSpecs.reverbMix.max);
      if (mix > 0) settings.lastAmount = mix;
    }
    if (patch.enabled === false) mix = 0;
    if (patch.enabled === true && mix === 0) mix = settings.lastAmount || defaultReverb.lastAmount;
    return { settings: validateReverb(settings), mix };
  }

  // extension/src/reverb.ts
  function impulseSamples(rate, settings) {
    const config = validateReverb(settings), preset = reverbPresets[config.preset];
    const length = Math.ceil(rate * config.duration), start2 = Math.round(rate * preset.preDelay);
    const response = [new Float32Array(length), new Float32Array(length)];
    const coefficient = 1 - Math.exp(-2 * Math.PI * preset.toneHz / rate);
    for (let channel = 0; channel < 2; channel++) {
      let seed = 12345 + channel * 9817, filtered = 0, energy = 0;
      const samples = response[channel];
      for (let i = start2; i < length; i++) {
        seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
        filtered += coefficient * (seed / 2147483648 - 1 - filtered);
        const time = (i - start2) / rate;
        samples[i] = filtered * Math.exp(-6.91 * time / (config.duration - preset.preDelay)) * Math.min(1, time / 0.01);
        energy += samples[i] ** 2;
      }
      const gain = 1 / Math.sqrt(Math.max(1e-8, energy));
      for (let i = start2; i < length; i++) samples[i] *= gain;
    }
    return response;
  }
  var LocalReverb = class {
    constructor(context, input, output) {
      this.context = context;
      this.input = input;
      this.output = output;
      this.dry = this.context.createGain();
      this.cache = /* @__PURE__ */ new Map();
      this.returns = /* @__PURE__ */ new Set();
      this.key = "";
      this.closed = false;
      input.connect(this.dry).connect(output);
    }
    ramp(param, value) {
      param.cancelAndHoldAtTime(this.context.currentTime);
      param.linearRampToValueAtTime(value, this.context.currentTime + 0.3);
    }
    retire(branch) {
      this.ramp(branch.gain.gain, 0);
      clearTimeout(branch.timer);
      branch.timer = setTimeout(() => {
        this.input.disconnect(branch.convolver);
        branch.convolver.disconnect();
        branch.gain.disconnect();
        this.returns.delete(branch);
      }, 350);
    }
    update(settings, amount) {
      if (this.closed) return;
      const config = validateReverb(settings);
      if (!Number.isFinite(amount) || amount < 0 || amount > effectSpecs.reverbMix.max) throw new Error("Invalid reverb amount.");
      clearTimeout(this.pending);
      this.ramp(this.dry.gain, Math.sqrt(1 - amount));
      if (!amount) {
        if (this.active) this.retire(this.active);
        this.active = void 0;
        this.key = "";
        return;
      }
      const key = `${config.preset}:${config.duration}`;
      if (key === this.key && this.active) {
        this.ramp(this.active.gain.gain, Math.sqrt(amount) * 0.8);
        return;
      }
      this.pending = setTimeout(() => {
        if (this.closed) return;
        let buffer = this.cache.get(key);
        if (!buffer) {
          const channels = impulseSamples(this.context.sampleRate, config);
          buffer = this.context.createBuffer(2, channels[0].length, this.context.sampleRate);
          channels.forEach((samples, channel) => buffer.getChannelData(channel).set(samples));
        }
        this.cache.delete(key);
        this.cache.set(key, buffer);
        if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        const convolver = this.context.createConvolver(), gain = this.context.createGain();
        convolver.normalize = false;
        convolver.buffer = buffer;
        gain.gain.value = 0;
        this.input.connect(convolver).connect(gain).connect(this.output);
        if (this.active) this.retire(this.active);
        this.active = { convolver, gain };
        this.returns.add(this.active);
        this.key = key;
        this.ramp(gain.gain, Math.sqrt(amount) * 0.8);
      }, 80);
    }
    disconnect() {
      this.closed = true;
      clearTimeout(this.pending);
      this.input.disconnect(this.dry);
      this.dry.disconnect();
      for (const branch of this.returns) {
        clearTimeout(branch.timer);
        this.input.disconnect(branch.convolver);
        branch.convolver.disconnect();
        branch.gain.disconnect();
      }
      this.returns.clear();
      this.cache.clear();
    }
  };

  // extension/src/audio-engine.ts
  var timeConstant = 0.075;
  var dbToGain = (db) => 10 ** (db / 20);
  var AudioEngine = class {
    constructor(context, stream) {
      this.context = context;
      this.stream = stream;
      this.nodes = [];
      this.source = this.track(this.context.createMediaStreamSource(this.stream));
      this.analyser = this.track(this.context.createAnalyser());
      this.original = this.gain(0);
      this.modified = this.gain(1);
      this.master = this.gain(1);
      this.monitorOut = this.gain(1);
      this.reverb = new LocalReverb(this.context, this.monitorOut, this.master);
      this.reverbSettings = { ...defaultReverb };
      this.fullInput = this.gain(1);
      this.stemInput = this.gain(0);
      this.activeStem = false;
      this.monitor = "modified";
      this.resyncUntil = 0;
      this.outputGain = this.gain(1);
      this.bass = this.filter("lowshelf", 150);
      this.treble = this.filter("highshelf", 4e3);
      this.highpass = this.filter("highpass", effectSpecs.highpassHz.neutral);
      this.lowpass = this.filter("lowpass", effectSpecs.lowpassHz.neutral);
      this.highpassDry = this.gain(1);
      this.highpassWet = this.gain(0);
      this.highpassOut = this.gain(1);
      this.lowpassDry = this.gain(1);
      this.lowpassWet = this.gain(0);
      this.lowpassOut = this.gain(1);
      this.distortionDry = this.gain(1);
      this.distortionWet = this.gain(0);
      this.effectsInput = this.gain(1);
      this.spaceDry = this.gain(1);
      this.delaySend = this.gain(0);
      this.delayReturn = this.gain(0);
      this.delay = this.track(this.context.createDelay(0.5));
      this.feedback = this.gain(0);
      this.effects = neutralEffects;
      this.source.connect(this.analyser);
      this.source.connect(this.original).connect(this.monitorOut);
      const limiter = this.track(context.createDynamicsCompressor());
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 16;
      limiter.attack.value = 3e-3;
      limiter.release.value = 0.12;
      this.master.connect(limiter).connect(context.destination);
      this.source.connect(this.fullInput).connect(this.bass).connect(this.treble);
      this.stemInput.connect(this.bass);
      this.treble.connect(this.highpassDry).connect(this.highpassOut);
      this.treble.connect(this.highpass).connect(this.highpassWet).connect(this.highpassOut);
      this.highpassOut.connect(this.lowpassDry).connect(this.lowpassOut);
      this.highpassOut.connect(this.lowpass).connect(this.lowpassWet).connect(this.lowpassOut);
      const shaper = this.track(context.createWaveShaper());
      const curve = new Float32Array(2049);
      for (let index = 0; index < curve.length; index++) {
        const x = 2 * index / (curve.length - 1) - 1;
        curve[index] = Math.tanh(2.5 * x) / 2.5;
      }
      shaper.curve = curve;
      shaper.oversample = "2x";
      this.lowpassOut.connect(this.distortionDry).connect(this.effectsInput);
      this.lowpassOut.connect(shaper).connect(this.distortionWet).connect(this.effectsInput);
      this.effectsInput.connect(this.spaceDry).connect(this.outputGain);
      this.delay.delayTime.value = 0.01;
      this.effectsInput.connect(this.delaySend).connect(this.delay).connect(this.delayReturn).connect(this.outputGain);
      this.delay.connect(this.feedback).connect(this.delay);
      this.outputGain.connect(this.modified).connect(this.monitorOut);
    }
    track(node) {
      this.nodes.push(node);
      return node;
    }
    gain(value) {
      const node = this.track(this.context.createGain());
      node.gain.value = value;
      return node;
    }
    filter(type, hz) {
      const node = this.track(this.context.createBiquadFilter());
      node.type = type;
      node.frequency.value = Math.min(hz, this.context.sampleRate / 2);
      node.Q.value = -3;
      return node;
    }
    setReverb(settings) {
      this.reverbSettings = settings;
      this.reverb.update(settings, this.effects.reverbMix);
    }
    ramp(param, value) {
      const now = this.context.currentTime;
      param.cancelAndHoldAtTime(now);
      param.setTargetAtTime(value, now, timeConstant);
    }
    setMonitor(mode) {
      this.monitor = mode;
      if (this.activeStem || this.context.currentTime < this.resyncUntil) {
        this.resync(this.original.gain, this.modified.gain, mode === "original");
        return;
      }
      this.ramp(this.original.gain, mode === "original" ? 1 : 0);
      this.ramp(this.modified.gain, mode === "modified" ? 1 : 0);
    }
    connectStem(capture, playback) {
      this.source.connect(capture);
      playback.connect(this.stemInput);
    }
    disconnectStem(capture) {
      this.source.disconnect(capture);
    }
    setStemActive(active) {
      if (active === this.activeStem) return;
      this.activeStem = active;
      this.resync(this.fullInput.gain, this.stemInput.gain, !active);
      this.resyncUntil = this.context.currentTime + 0.05;
      this.resync(this.original.gain, this.modified.gain, this.monitor === "original");
    }
    resync(first, second, useFirst) {
      const now = this.context.currentTime;
      const dip = now + 0.025;
      const selected = useFirst ? first : second;
      for (const param of [first, second]) {
        param.cancelAndHoldAtTime(now);
        param.linearRampToValueAtTime(0, dip);
      }
      selected.linearRampToValueAtTime(1, dip + 0.025);
    }
    setMuted(muted) {
      this.ramp(this.master.gain, muted ? 0 : 1);
    }
    setEffects(next) {
      const previous = this.effects;
      if (previous.bassDb !== next.bassDb) this.ramp(this.bass.gain, next.bassDb);
      if (previous.trebleDb !== next.trebleDb) this.ramp(this.treble.gain, next.trebleDb);
      if (previous.highpassHz !== next.highpassHz) {
        this.setCut(this.highpass, this.highpassDry, this.highpassWet, next.highpassHz, neutralEffects.highpassHz);
      }
      if (previous.lowpassHz !== next.lowpassHz) {
        this.setCut(this.lowpass, this.lowpassDry, this.lowpassWet, next.lowpassHz, neutralEffects.lowpassHz);
      }
      if (previous.distortion !== next.distortion) {
        this.ramp(this.distortionDry.gain, 1 - next.distortion);
        this.ramp(this.distortionWet.gain, next.distortion);
      }
      const echo = next.delayMs > 0 ? next.delayMix : 0;
      const oldEcho = previous.delayMs > 0 ? previous.delayMix : 0;
      if (next.delayMs !== previous.delayMs && next.delayMs > 0) {
        this.ramp(this.delay.delayTime, next.delayMs / 1e3);
      }
      if (oldEcho !== echo || next.delayFeedback !== previous.delayFeedback) {
        this.ramp(this.feedback.gain, echo > 0 ? next.delayFeedback : 0);
      }
      if (previous.reverbMix !== next.reverbMix) this.reverb.update(this.reverbSettings, next.reverbMix);
      if (oldEcho !== echo) {
        this.ramp(this.spaceDry.gain, 1 - echo);
        this.ramp(this.delayReturn.gain, echo * (1 - next.delayFeedback));
        this.ramp(this.delaySend.gain, echo > 0 ? 1 : 0);
      } else if (next.delayFeedback !== previous.delayFeedback && echo > 0) {
        this.ramp(this.delayReturn.gain, echo * (1 - next.delayFeedback));
      }
      if (previous.outputGainDb !== next.outputGainDb) this.ramp(this.outputGain.gain, dbToGain(next.outputGainDb));
      this.effects = next;
    }
    setCut(filter, dry, wet, hz, neutral) {
      const active = hz !== neutral;
      this.ramp(filter.frequency, Math.min(hz, this.context.sampleRate / 2));
      this.ramp(dry.gain, active ? 0 : 1);
      this.ramp(wet.gain, active ? 1 : 0);
    }
    disconnect() {
      this.reverb.disconnect();
      this.nodes.forEach((node) => node.disconnect());
    }
  };

  // extension/src/shared/types.ts
  var silentFeatures = Object.freeze({
    rms: 0,
    bassEnergy: 0,
    midEnergy: 0,
    trebleEnergy: 0,
    brightness: 0,
    isSilent: true
  });

  // extension/src/audio-features.ts
  var AudioFeaturesMeter = class {
    constructor(analyser, sampleRate) {
      this.analyser = analyser;
      this.sampleRate = sampleRate;
      this.history = [];
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      this.timeDomain = new Float32Array(analyser.fftSize);
      this.spectrum = new Float32Array(analyser.frequencyBinCount);
    }
    sample(now = performance.now()) {
      const { rms, bassEnergy, midEnergy, trebleEnergy, brightness } = silentFeatures;
      const values = { rms, bassEnergy, midEnergy, trebleEnergy, brightness };
      this.analyser.getFloatTimeDomainData(this.timeDomain);
      this.analyser.getFloatFrequencyData(this.spectrum);
      let squares = 0;
      for (const value of this.timeDomain) squares += value * value;
      values.rms = Math.min(1, Math.sqrt(squares / this.timeDomain.length));
      if (values.rms >= 1e-3) {
        let bass = 0;
        let mid = 0;
        let treble = 0;
        let weighted = 0;
        for (let bin = 1; bin < this.spectrum.length; bin++) {
          const hz = bin * this.sampleRate / this.analyser.fftSize;
          const power = 10 ** (this.spectrum[bin] / 10);
          if (hz < 250) bass += power;
          else if (hz < 2e3) mid += power;
          else treble += power;
          weighted += Math.min(hz, 1e4) * power;
        }
        const total = bass + mid + treble;
        if (total > 0) {
          values.bassEnergy = bass / total;
          values.midEnergy = mid / total;
          values.trebleEnergy = treble / total;
          values.brightness = weighted / (total * 1e4);
        }
      }
      this.history.push({ at: now, values });
      while (this.history[0].at < now - 2e3) this.history.shift();
      const average = { ...silentFeatures };
      const keys = ["rms", "bassEnergy", "midEnergy", "trebleEnergy", "brightness"];
      for (const key of keys) {
        const total = this.history.reduce((sum, entry) => sum + entry.values[key], 0);
        average[key] = Math.min(1, total / this.history.length);
      }
      average.isSilent = this.history.every((entry) => entry.values.rms < 1e-3);
      return average;
    }
  };

  // extension/src/shared/deployment.ts
  var localStemWsUrl = "ws://127.0.0.1:8788";
  var dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  function endpoint(raw, name, protocol, local, forStems) {
    const invalid = new Error(`${name} must be a ${protocol} endpoint on ${local ? "127.0.0.1" : "a specific public DNS hostname"}.`);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw invalid;
    }
    if (raw !== raw.trim() || !raw.startsWith(protocol + "//") || url.protocol !== protocol || url.username || url.password || /[\s?#\\@]/.test(raw) || url.pathname !== "/" && !(forStems && !local && url.pathname === "/stem")) throw invalid;
    if (raw !== url.origin && raw !== url.href) throw invalid;
    if (local) {
      if (url.hostname !== "127.0.0.1" || (forStems ? Number(url.port) < 1024 : url.port !== "8787")) throw invalid;
    } else if (url.port || !dnsName.test(url.hostname) || /\.(local|localhost|internal)$/.test(url.hostname)) {
      throw invalid;
    }
    return url;
  }
  function deploymentFromEnv(mode, env) {
    if (mode !== "development" && mode !== "production") throw new Error("Build mode must be development or production.");
    const local = mode === "development";
    const api = endpoint(
      env.API_BASE_URL ?? (local ? "http://127.0.0.1:8787" : ""),
      "API_BASE_URL",
      local ? "http:" : "https:",
      local,
      false
    );
    const stemUrl = env.STEM_WS_URL ?? (local ? localStemWsUrl : "");
    const localStem = local || stemUrl === localStemWsUrl || stemUrl === localStemWsUrl + "/";
    const stems = endpoint(stemUrl, "STEM_WS_URL", localStem ? "ws:" : "wss:", localStem, true);
    const delay = env.STEM_DELAY_SECONDS === void 0 ? local ? 2.8 : 4.5 : Number(env.STEM_DELAY_SECONDS);
    if (!Number.isFinite(delay) || delay < 2.8 || delay > 8 || Math.round(delay * 10) / 10 !== delay) {
      throw new Error("STEM_DELAY_SECONDS must be 2.8 to 8.0 seconds in tenths.");
    }
    return {
      mode,
      apiBaseUrl: api.origin,
      stemWsUrl: stems.origin + (stems.pathname === "/" ? "" : stems.pathname),
      stemDelaySeconds: delay
    };
  }
  var deployment = typeof define_MOODSHIFT_DEPLOYMENT_default === "undefined" ? deploymentFromEnv("development", {}) : define_MOODSHIFT_DEPLOYMENT_default;
  function usesCloudStems(config = deployment) {
    return config.stemWsUrl.startsWith("wss://");
  }

  // extension/src/stem-stream.ts
  var loaded = /* @__PURE__ */ new WeakMap();
  var StemStream = class {
    constructor(context, engine, buffering, unavailable) {
      this.context = context;
      this.engine = engine;
      this.unavailable = unavailable;
      this.connected = false;
      this.closed = false;
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.timer = setTimeout(() => this.fail("The stem helper did not start in time."), (deployment.stemDelaySeconds + 2.7) * 1e3);
      void this.start(buffering).catch(() => this.fail("Could not initialize stem playback."));
    }
    async start(buffering) {
      let demoCode;
      if (usesCloudStems()) {
        try {
          const reply = await chrome.runtime.sendMessage({
            target: "worker",
            type: "GET_STEM_CODE"
          });
          if (!reply.ok) throw new Error(reply.message);
          demoCode = reply.code;
        } catch (error) {
          this.fail(error instanceof Error ? error.message : "Could not read the private demo code.");
          return;
        }
      }
      if (this.closed) return;
      let module = loaded.get(this.context);
      if (!module) {
        module = this.context.audioWorklet.addModule(chrome.runtime.getURL("stem-worklet.js"));
        loaded.set(this.context, module);
        void module.catch(() => loaded.delete(this.context));
      }
      await module;
      if (this.closed) return;
      const gain = () => {
        const node2 = this.context.createGain();
        node2.gain.value = 0;
        return node2;
      };
      const node = new AudioWorkletNode(this.context, "stem-audio", {
        outputChannelCount: [4],
        channelCount: 2,
        channelCountMode: "explicit"
      });
      this.node = node;
      const splitter = this.context.createChannelSplitter(4);
      this.splitter = splitter;
      node.connect(splitter);
      this.playback = this.context.createGain();
      this.vocals = gain();
      this.instrumental = gain();
      for (const [offset, branch] of [[0, this.vocals], [2, this.instrumental]]) {
        const stereo = this.context.createChannelMerger(2);
        splitter.connect(stereo, offset, 0);
        splitter.connect(stereo, offset + 1, 1);
        stereo.connect(branch).connect(this.playback);
      }
      this.engine.connectStem(node, this.playback);
      this.connected = true;
      const channel = new MessageChannel();
      const worker = new Worker(chrome.runtime.getURL("stem-worker.js"));
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.closed) return;
        if (data.type === "buffering") buffering();
        if (data.type === "active") {
          clearTimeout(this.timer);
          this.resolveReady();
        }
        if (data.type === "error") this.fail(data.message);
      };
      worker.onerror = () => this.fail("Stem communication failed.");
      node.onprocessorerror = () => this.fail("Chrome stopped the stem audio processor.");
      node.port.postMessage(channel.port1, [channel.port1]);
      worker.postMessage({
        port: channel.port2,
        sampleRate: this.context.sampleRate,
        sessionId: crypto.randomUUID().replaceAll("-", ""),
        demoCode
      }, [channel.port2]);
    }
    select(mode) {
      if (!this.vocals || !this.instrumental) return;
      const now = this.context.currentTime;
      for (const [branch, name] of [[this.vocals, "vocals"], [this.instrumental, "instrumental"]]) {
        branch.gain.cancelAndHoldAtTime(now);
        branch.gain.linearRampToValueAtTime(Number(mode === name), now + 0.05);
      }
    }
    fail(message) {
      if (this.closed) return;
      this.unavailable(message);
      this.close(message);
    }
    close(message = "Stem selection was replaced or stopped.") {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.timer);
      this.rejectReady(new Error(message));
      this.worker?.terminate();
      if (this.node) {
        if (this.connected) this.engine.disconnectStem(this.node);
        this.node.port.close();
      }
      setTimeout(() => {
        this.node?.disconnect();
        this.splitter?.disconnect();
        this.vocals?.disconnect();
        this.instrumental?.disconnect();
        this.playback?.disconnect();
      }, 55);
    }
  };

  // extension/src/shared/messages.ts
  var meterChannel = "moodshift-meter";
  function statusChanged() {
    void chrome.runtime.sendMessage({ target: "panel", type: "STATUS_CHANGED" }).catch(() => void 0);
  }

  // extension/src/offscreen.ts
  var live;
  var problem;
  var pending = Promise.resolve();
  var meterUpdates = new BroadcastChannel(meterChannel);
  function read() {
    if (live) {
      const { session, effects, revision, monitor, features, context, stem, reverb } = live;
      return { phase: "capturing", session, effects, revision, monitor, features, stem, reverb, outputPaused: context.state !== "running" };
    }
    return problem ? { phase: "error", message: problem } : { phase: "ready" };
  }
  async function stop(sessionId, error) {
    if (live?.session.id !== sessionId) return;
    const { engine, stream, context, timer, stemStream } = live;
    const capture = live;
    live = void 0;
    const restoring = releaseSpeed(capture);
    problem = error;
    clearInterval(timer);
    stemStream?.close();
    engine?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    if (context.state !== "closed") await context.close();
    await restoring;
  }
  async function releaseSpeed(capture) {
    clearInterval(capture.speedTimer);
    capture.speedTimer = void 0;
    const owner = capture.speedOwner;
    capture.speedOwner = void 0;
    capture.reverb.speed = { state: "idle" };
    if (owner) await chrome.runtime.sendMessage({
      target: "worker",
      type: "SYNC_REVERB_RATE",
      sessionId: capture.session.id,
      owner,
      enabled: false
    }).catch(() => void 0);
  }
  async function syncSpeed(capture, restart = false) {
    if (capture.effects.reverbMix === 0 || capture.reverb.preset !== "slowed") {
      await releaseSpeed(capture);
      return;
    }
    if (restart) await releaseSpeed(capture);
    if (capture.speedOwner) return;
    const owner = capture.speedOwner = crypto.randomUUID();
    const renew = async () => {
      let speed;
      try {
        speed = await chrome.runtime.sendMessage({
          target: "worker",
          type: "SYNC_REVERB_RATE",
          sessionId: capture.session.id,
          owner,
          enabled: true
        });
        if (!speed || !["active", "unavailable"].includes(speed.state) || speed.state === "active" && (typeof speed.rate !== "number" || !Number.isFinite(speed.rate) || speed.rate <= 0)) throw new Error("Invalid speed acknowledgment.");
      } catch {
        speed = { state: "unavailable", message: "Reverb active. Playback slowing is unavailable." };
      }
      if (live !== capture || capture.speedOwner !== owner) return;
      capture.reverb.speed = speed;
      if (speed.state !== "active") {
        clearInterval(capture.speedTimer);
        capture.speedTimer = void 0;
      }
      statusChanged();
    };
    await renew();
    if (live === capture && capture.speedOwner === owner && capture.reverb.speed.state === "active") {
      capture.speedTimer = setInterval(() => void renew(), 2e3);
    }
  }
  async function applyReverb(capture, settings, effects, restart = false) {
    capture.engine.setReverb(settings);
    capture.engine.setEffects(effects);
    capture.effects = effects;
    capture.reverb = { ...settings, lastAmount: effects.reverbMix || settings.lastAmount, speed: capture.reverb.speed };
    capture.revision++;
    await syncSpeed(capture, restart);
  }
  function queue(work) {
    const next = pending.then(work);
    pending = next.then(() => void 0, () => void 0);
    return next;
  }
  function end(sessionId, error) {
    void queue(async () => {
      if (live?.session.id !== sessionId) return;
      await stop(sessionId, error);
      statusChanged();
      void chrome.runtime.sendMessage({ target: "worker", type: "AUDIO_ENDED", sessionId }).catch(() => void 0);
    }).catch(console.error);
  }
  async function start(session, streamId) {
    if (live?.session.id === session.id) return;
    if (live) throw new Error("Stop the current source before switching tabs.");
    problem = void 0;
    const constraints = {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    };
    let stream;
    let expired = false;
    let timeout;
    try {
      const media = navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      stream = await Promise.race([
        media.then((result) => {
          if (expired) result.getTracks().forEach((track2) => track2.stop());
          return result;
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            reject(new Error("Capture timed out. Click MoodShift on the source tab to retry."));
          }, 4e3);
        })
      ]);
      clearTimeout(timeout);
      const track = stream.getAudioTracks()[0];
      if (track?.readyState !== "live") throw new Error("The tab did not provide a live audio track.");
      const context = new AudioContext({ latencyHint: "interactive" });
      const capture = {
        session,
        stream,
        context,
        effects: { ...neutralEffects },
        monitor: "modified",
        revision: 0,
        features: silentFeatures,
        stem: { phase: "idle", mode: "full" },
        stemRequest: 0,
        reverb: { ...defaultReverb, speed: { state: "idle" } }
      };
      live = capture;
      live.engine = new AudioEngine(context, stream);
      if (session.muted) live.engine.setMuted(true);
      if (context.state !== "running") {
        await Promise.race([
          context.resume(),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, 1500);
          })
        ]);
      }
      if (context.state !== "running") {
        throw new Error("Chrome paused audio output. Play the source and click MoodShift on that tab to retry.");
      }
      if (track.readyState !== "live") throw new Error("Capture ended during startup. Click MoodShift to retry.");
      track.addEventListener("ended", () => end(session.id), { once: true });
      context.addEventListener("statechange", () => {
        if (live !== capture) return;
        if (context.state === "closed") end(session.id, "Audio output closed. Click MoodShift to retry.");
        else if (context.state !== "running" && capture.stemStream) {
          resetStem(capture, "Audio output paused. Select a stem to retry after resuming.");
        } else statusChanged();
      });
      const meter = new AudioFeaturesMeter(live.engine.analyser, context.sampleRate);
      capture.timer = setInterval(() => {
        capture.features = context.state === "running" ? meter.sample() : silentFeatures;
        meterUpdates.postMessage({ sessionId: session.id, features: capture.features });
      }, 250);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      const message = error instanceof Error ? error.message : "Chrome could not capture audio.";
      await stop(session.id, message);
      problem = message;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function resetStem(capture, message) {
    capture.stemRequest++;
    capture.engine?.setStemActive(false);
    capture.stemStream?.close(message);
    capture.stemStream = void 0;
    capture.stem = message ? { phase: "unavailable", mode: "full", message } : { phase: "idle", mode: "full" };
    statusChanged();
  }
  async function selectStem(message) {
    const capture = live;
    const engine = capture?.engine;
    if (!capture || !engine || capture.session.id !== message.sessionId) {
      return { ok: false, message: "The selected tab changed." };
    }
    if (message.baseRevision !== void 0 && message.baseRevision !== capture.revision) {
      return { ok: false, message: "Effects changed while Gemini was interpreting. Submit again." };
    }
    const mode = message.mode;
    if (mode === "full") {
      resetStem(capture);
      capture.monitor = "modified";
      engine.setMonitor("modified");
      return { ok: true, status: read() };
    }
    if (mode !== "vocals" && mode !== "instrumental") return { ok: false, message: "Unsupported stem mode." };
    if (capture.context.state !== "running" || capture.session.muted) {
      const detail = "Resume or unmute the source tab before selecting a stem.";
      resetStem(capture, detail);
      return { ok: false, message: detail };
    }
    if (capture.context.sampleRate !== 44100 && capture.context.sampleRate !== 48e3) {
      const detail = `Stems require a 44.1 or 48 kHz audio context. Current rate is ${capture.context.sampleRate} Hz.`;
      resetStem(capture, detail);
      return { ok: false, message: detail };
    }
    const request = ++capture.stemRequest;
    if (!capture.stemStream) {
      capture.stem = { phase: "loading", mode };
      const stream2 = new StemStream(capture.context, engine, () => {
        if (live === capture && capture.stemStream === stream2 && capture.stem.phase === "loading") {
          capture.stem = { phase: "buffering", mode: capture.stem.mode };
          statusChanged();
        }
      }, (detail) => {
        if (live === capture && capture.stemStream === stream2) resetStem(capture, detail);
      });
      capture.stemStream = stream2;
    } else if (capture.stem.phase === "loading" || capture.stem.phase === "buffering") {
      capture.stem = { phase: capture.stem.phase, mode };
    }
    statusChanged();
    const stream = capture.stemStream;
    try {
      await stream.ready;
      if (live !== capture || request !== capture.stemRequest) {
        return { ok: false, message: "Stem selection changed." };
      }
      if (message.baseRevision !== void 0 && message.baseRevision !== capture.revision) {
        const detail = "Effects changed while the stem was buffering. Submit again.";
        if (capture.stem.phase !== "active") resetStem(capture, detail);
        return { ok: false, message: detail };
      }
      stream.select(mode);
      capture.monitor = "modified";
      engine.setStemActive(true);
      engine.setMonitor("modified");
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (live !== capture || request !== capture.stemRequest) return { ok: false, message: "Stem selection changed." };
      if (capture.context.state !== "running") {
        const detail = "Audio output paused while the stem was activating.";
        resetStem(capture, detail);
        return { ok: false, message: detail };
      }
      capture.stem = { phase: "active", mode };
      statusChanged();
      return { ok: true, status: read() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Stem output unavailable." };
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== "audio") return;
    if (message.type === "SET_STEM") {
      void selectStem(message).then(sendResponse, () => sendResponse({ ok: false, message: "Stem output unavailable." }));
      return true;
    }
    void queue(async () => {
      if (message.type === "START") await start(message.session, message.streamId);
      if (message.type === "STOP") await stop(message.sessionId);
      if (message.type === "APPLY_EFFECTS" || message.type === "SET_MONITOR" || message.type === "UPDATE_TAB" || message.type === "SET_REVERB") {
        const capture = live;
        if (!capture?.engine || capture.session.id !== message.sessionId) {
          return { ok: false, message: "The selected tab changed. Try again on the current source." };
        }
        if (message.type === "SET_REVERB") {
          const { preset, duration, lastAmount } = capture.reverb;
          const next = changeReverb({ preset, duration, lastAmount }, capture.effects.reverbMix, message.patch);
          await applyReverb(capture, next.settings, applyPatch(capture.effects, { reverbMix: next.mix }), message.patch.preset !== void 0 || message.patch.enabled === true);
        } else if (message.type === "APPLY_EFFECTS") {
          if (message.baseRevision !== void 0 && message.baseRevision !== capture.revision) {
            return { ok: false, message: "Effects changed while Gemini was interpreting. Submit again to use the current settings." };
          }
          const next = applyPatch(capture.effects, message.patch);
          const { preset, duration, lastAmount } = capture.reverb;
          await applyReverb(capture, message.reverb ? validateReverb(message.reverb) : { preset, duration, lastAmount }, next, message.reverb !== void 0);
        } else if (message.type === "SET_MONITOR") {
          if (message.baseRevision !== void 0 && message.baseRevision !== capture.revision) {
            return { ok: false, message: "Effects changed before switching the monitor." };
          }
          if (message.monitor !== "original" && message.monitor !== "modified") throw new Error("Invalid monitor mode.");
          capture.engine.setMonitor(message.monitor);
          capture.monitor = message.monitor;
        } else {
          if (message.title !== void 0) capture.session.title = message.title;
          if (message.muted !== void 0) {
            capture.engine.setMuted(message.muted);
            capture.session.muted = message.muted;
            if (message.muted && capture.stemStream) resetStem(capture, "Source muted. Select a stem after unmuting.");
          }
        }
      }
      return { ok: true, status: read() };
    }).then(sendResponse, (error) => sendResponse({ ok: false, message: String(error.message ?? error) }));
    return true;
  });
})();
