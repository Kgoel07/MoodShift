"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

  // extension/src/shared/stem-pcm.ts
  var stemPacketFrames = 2048;
  var stemHeaderBytes = 4;
  var stereoFrameBytes = 8;

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

  // extension/src/stem-worklet.ts
  function packetView(buffer) {
    return { buffer, header: new DataView(buffer), stereo: new Float32Array(buffer, stemHeaderBytes) };
  }
  var StemAudio = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.delay = Math.round(sampleRate * deployment.stemDelaySeconds);
      this.capacity = Math.ceil(sampleRate * Math.max(4, deployment.stemDelaySeconds + 0.25));
      this.dry = new Float32Array(this.capacity * 2);
      this.vocals = new Float32Array(this.capacity * 2);
      this.pool = [];
      this.packetOffset = 0;
      this.packetFrame = 0;
      this.position = 0;
      this.vocalsEnd = 0;
      this.started = false;
      this.signaled = false;
      this.failed = false;
      for (let index = 0; index < 8; index++) {
        this.pool.push(packetView(new ArrayBuffer(stemHeaderBytes + stemPacketFrames * stereoFrameBytes)));
      }
      this.port.onmessage = ({ data }) => {
        this.channel = data;
        data.onmessage = ({ data: message }) => this.receive(message);
      };
    }
    receive(message) {
      if (message.type === "start") this.started = true;
      if (message.type === "recycle") this.pool.push(packetView(message.buffer));
      if (message.type !== "vocals" || this.failed) return;
      const offset = new DataView(message.buffer).getUint32(0, true);
      const pcm = new Float32Array(message.buffer, stemHeaderBytes);
      const playback = Math.max(0, this.position - this.delay);
      if (offset !== this.vocalsEnd || offset < playback || offset + pcm.length / 2 - playback > this.capacity) {
        this.fail("Stem audio missed its playback deadline.");
        return;
      }
      const start = offset % this.capacity * 2;
      const first = Math.min(pcm.length, this.vocals.length - start);
      this.vocals.set(pcm.subarray(0, first), start);
      if (first < pcm.length) this.vocals.set(pcm.subarray(first));
      this.vocalsEnd += pcm.length / 2;
    }
    fail(message) {
      if (this.failed) return;
      this.failed = true;
      this.channel?.postMessage({ type: "error", message });
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const input = inputs[0];
      if (!this.started || this.failed || !output[0]) return true;
      const left = input[0];
      const right = input[1] ?? left;
      for (let index = 0; index < output[0].length; index++) {
        const position = this.position++;
        const dryIndex = position % this.capacity * 2;
        const l = left?.[index] ?? 0;
        const r = right?.[index] ?? 0;
        this.dry[dryIndex] = l;
        this.dry[dryIndex + 1] = r;
        if (!this.packet) this.packet = this.pool.pop();
        const packet = this.packet;
        if (!packet) {
          this.fail("The stem audio buffer ran out.");
          break;
        }
        packet.stereo[this.packetOffset++] = l;
        packet.stereo[this.packetOffset++] = r;
        if (this.packetOffset === packet.stereo.length) {
          packet.header.setUint32(0, this.packetFrame, true);
          this.channel?.postMessage({ type: "capture", buffer: packet.buffer }, [packet.buffer]);
          this.packetFrame += stemPacketFrames;
          this.packet = void 0;
          this.packetOffset = 0;
        }
        const playback = position - this.delay;
        if (playback < 0) continue;
        if (playback >= this.vocalsEnd) {
          this.fail("Stem audio buffer underrun. Returned to the full mix.");
          break;
        }
        const offset = playback % this.capacity * 2;
        const vocalL = this.vocals[offset];
        const vocalR = this.vocals[offset + 1];
        output[0][index] = vocalL;
        output[1][index] = vocalR;
        output[2][index] = this.dry[offset] - vocalL;
        output[3][index] = this.dry[offset + 1] - vocalR;
        if (!this.signaled) {
          this.signaled = true;
          this.channel?.postMessage({ type: "active", queuedFrames: position - playback });
        }
      }
      return true;
    }
  };
  registerProcessor("stem-audio", StemAudio);
})();
