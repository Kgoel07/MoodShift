"use strict";
(() => {
  // extension/src/shared/stem-pcm.ts
  var stemPacketFrames = 2048;
  var stemHeaderBytes = 4;
  var stereoFrameBytes = 8;
  var stemDelaySeconds = 2.8;

  // extension/src/stem-worklet.ts
  function packetView(buffer) {
    return { buffer, header: new DataView(buffer), stereo: new Float32Array(buffer, stemHeaderBytes) };
  }
  var StemAudio = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.delay = Math.round(sampleRate * stemDelaySeconds);
      this.capacity = Math.ceil(sampleRate * 4);
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
          this.channel?.postMessage({ type: "active" });
        }
      }
      return true;
    }
  };
  registerProcessor("stem-audio", StemAudio);
})();
