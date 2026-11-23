"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

  // extension/src/shared/stem-pcm.ts
  var stemHeaderBytes = 4;
  var stereoFrameBytes = 8;

  // extension/src/shared/deployment.ts
  var demoCodePattern = /^[A-Za-z0-9_-]{32,128}$/;
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

  // extension/src/api-client.ts
  function stemStartMessage(sampleRate, sessionId, config, code) {
    if (usesCloudStems(config)) {
      if (!code || !demoCodePattern.test(code)) throw new Error("Cloud stems require a private demo code.");
      return { type: "start", sampleRate, sessionId, token: code };
    }
    if (config.mode === "production" && config.stemWsUrl !== localStemWsUrl) {
      throw new Error("Cloud stems require WSS.");
    }
    return { type: "start", sampleRate, sessionId };
  }

  // extension/src/stem-worker.ts
  self.onmessage = ({ data }) => {
    const { port, sampleRate, sessionId, demoCode } = data;
    const hello = stemStartMessage(sampleRate, sessionId, deployment, demoCode);
    const socket = new WebSocket(deployment.stemWsUrl);
    socket.binaryType = "arraybuffer";
    let ready = false;
    let ended = false;
    let expectedFrame = 0;
    let hop = 0;
    function fail(message) {
      if (ended) return;
      ended = true;
      self.postMessage({ type: "error", message });
      socket.close();
      port.close();
    }
    socket.onopen = () => socket.send(JSON.stringify(hello));
    socket.onerror = () => fail(usesCloudStems() ? "Could not connect to the cloud stem worker." : "Start the local stem helper for this extension.");
    socket.onclose = (event) => fail(event.reason || "Stem helper disconnected.");
    socket.onmessage = ({ data: response }) => {
      if (typeof response === "string" && !ready) {
        try {
          const reply = JSON.parse(response);
          if (reply.type !== "ready" || reply.sessionId !== sessionId || reply.hop !== Math.round(sampleRate * 1.84)) {
            throw new Error("Invalid helper reply.");
          }
          hop = reply.hop;
          ready = true;
          port.postMessage({ type: "start" });
          self.postMessage({ type: "buffering" });
        } catch {
          fail("The helper could not establish a stem session.");
        }
        return;
      }
      if (!ready || !(response instanceof ArrayBuffer) || response.byteLength !== stemHeaderBytes + hop * stereoFrameBytes || new DataView(response).getUint32(0, true) !== expectedFrame) {
        fail("Stem audio arrived out of order.");
        return;
      }
      expectedFrame += hop;
      port.postMessage({ type: "vocals", buffer: response }, [response]);
    };
    port.onmessage = ({ data: data2 }) => {
      if (data2.type === "error") {
        fail(data2.message);
      } else if (data2.type === "active") {
        self.postMessage(data2);
      } else if (data2.type === "capture") {
        if (!ready || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) {
          fail("The stem helper is falling behind.");
          return;
        }
        socket.send(data2.buffer);
        port.postMessage({ type: "recycle", buffer: data2.buffer }, [data2.buffer]);
      }
    };
  };
})();
