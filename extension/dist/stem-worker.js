"use strict";
(() => {
  // extension/src/shared/stem-pcm.ts
  var stemHeaderBytes = 4;
  var stereoFrameBytes = 8;

  // extension/src/stem-worker.ts
  self.onmessage = ({ data }) => {
    const { port, sampleRate, sessionId } = data;
    const socket = new WebSocket("ws://127.0.0.1:8788");
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
    socket.onopen = () => socket.send(JSON.stringify({ type: "start", sampleRate, sessionId }));
    socket.onerror = () => fail("Start the local stem helper for this extension.");
    socket.onclose = (event) => fail(event.reason || "Local stem helper disconnected.");
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
          fail("The local helper could not establish a stem session.");
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
          fail("The local helper is falling behind.");
          return;
        }
        socket.send(data2.buffer);
        port.postMessage({ type: "recycle", buffer: data2.buffer }, [data2.buffer]);
      }
    };
  };
})();
