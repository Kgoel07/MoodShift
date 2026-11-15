import { stemDelaySeconds, stemHeaderBytes, stemPacketFrames, stereoFrameBytes, type PCMMessage } from './shared/stem-pcm';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

interface Packet {
  buffer: ArrayBuffer;
  stereo: Float32Array;
  header: DataView;
}

function packetView(buffer: ArrayBuffer): Packet {
  return { buffer, header: new DataView(buffer), stereo: new Float32Array(buffer, stemHeaderBytes) };
}

class StemAudio extends AudioWorkletProcessor {
  private readonly delay = Math.round(sampleRate * stemDelaySeconds);
  private readonly capacity = Math.ceil(sampleRate * 4);
  private readonly dry = new Float32Array(this.capacity * 2);
  private readonly vocals = new Float32Array(this.capacity * 2);
  private readonly pool: Packet[] = [];
  private channel?: MessagePort;
  private packet?: Packet;
  private packetOffset = 0;
  private packetFrame = 0;
  private position = 0;
  private vocalsEnd = 0;
  private started = false;
  private signaled = false;
  private failed = false;

  constructor() {
    super();
    for (let index = 0; index < 8; index++) {
      this.pool.push(packetView(new ArrayBuffer(stemHeaderBytes + stemPacketFrames * stereoFrameBytes)));
    }
    this.port.onmessage = ({ data }: MessageEvent<MessagePort>) => {
      this.channel = data;
      data.onmessage = ({ data: message }: MessageEvent<PCMMessage>) => this.receive(message);
    };
  }

  private receive(message: PCMMessage): void {
    if (message.type === 'start') this.started = true;
    if (message.type === 'recycle') this.pool.push(packetView(message.buffer));
    if (message.type !== 'vocals' || this.failed) return;
    const offset = new DataView(message.buffer).getUint32(0, true);
    const pcm = new Float32Array(message.buffer, stemHeaderBytes);
    const playback = Math.max(0, this.position - this.delay);
    if (offset !== this.vocalsEnd || offset < playback || offset + pcm.length / 2 - playback > this.capacity) {
      this.fail('Stem audio missed its playback deadline.');
      return;
    }
    const start = (offset % this.capacity) * 2;
    const first = Math.min(pcm.length, this.vocals.length - start);
    this.vocals.set(pcm.subarray(0, first), start);
    if (first < pcm.length) this.vocals.set(pcm.subarray(first));
    this.vocalsEnd += pcm.length / 2;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.channel?.postMessage({ type: 'error', message } satisfies PCMMessage);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const input = inputs[0];
    if (!this.started || this.failed || !output[0]) return true;
    const left = input[0];
    const right = input[1] ?? left;
    for (let index = 0; index < output[0].length; index++) {
      const position = this.position++;
      const dryIndex = (position % this.capacity) * 2;
      const l = left?.[index] ?? 0;
      const r = right?.[index] ?? 0;
      this.dry[dryIndex] = l;
      this.dry[dryIndex + 1] = r;
      if (!this.packet) this.packet = this.pool.pop();
      const packet = this.packet;
      if (!packet) {
        this.fail('The stem audio buffer ran out.');
        break;
      }
      packet.stereo[this.packetOffset++] = l;
      packet.stereo[this.packetOffset++] = r;
      if (this.packetOffset === packet.stereo.length) {
        packet.header.setUint32(0, this.packetFrame, true);
        this.channel?.postMessage({ type: 'capture', buffer: packet.buffer } satisfies PCMMessage, [packet.buffer]);
        this.packetFrame += stemPacketFrames;
        this.packet = undefined;
        this.packetOffset = 0;
      }

      const playback = position - this.delay;
      if (playback < 0) continue;
      if (playback >= this.vocalsEnd) {
        this.fail('Stem audio buffer underrun. Returned to the full mix.');
        break;
      }
      const offset = (playback % this.capacity) * 2;
      const vocalL = this.vocals[offset];
      const vocalR = this.vocals[offset + 1];
      output[0][index] = vocalL;
      output[1][index] = vocalR;
      output[2][index] = this.dry[offset] - vocalL;
      output[3][index] = this.dry[offset + 1] - vocalR;
      if (!this.signaled) {
        this.signaled = true;
        this.channel?.postMessage({ type: 'active' } satisfies PCMMessage);
      }
    }
    return true;
  }
}

registerProcessor('stem-audio', StemAudio);
