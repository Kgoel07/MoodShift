import { stemHeaderBytes, stereoFrameBytes, type PCMMessage, type StemWorkerStart } from './shared/stem-pcm';

self.onmessage = ({ data }: MessageEvent<StemWorkerStart>) => {
  const { port, sampleRate, sessionId } = data;
  const socket = new WebSocket('ws://127.0.0.1:8788');
  socket.binaryType = 'arraybuffer';
  let ready = false;
  let ended = false;
  let expectedFrame = 0;
  let hop = 0;

  function fail(message: string): void {
    if (ended) return;
    ended = true;
    self.postMessage({ type: 'error', message });
    socket.close();
    port.close();
  }

  socket.onopen = () => socket.send(JSON.stringify({ type: 'start', sampleRate, sessionId }));
  socket.onerror = () => fail('Start the local stem helper for this extension.');
  socket.onclose = event => fail(event.reason || 'Local stem helper disconnected.');
  socket.onmessage = ({ data: response }: MessageEvent<string | ArrayBuffer>) => {
    if (typeof response === 'string' && !ready) {
      try {
        const reply = JSON.parse(response);
        if (reply.type !== 'ready' || reply.sessionId !== sessionId || reply.hop !== Math.round(sampleRate * 1.84)) {
          throw new Error('Invalid helper reply.');
        }
        hop = reply.hop;
        ready = true;
        port.postMessage({ type: 'start' } satisfies PCMMessage);
        self.postMessage({ type: 'buffering' });
      } catch {
        fail('The local helper could not establish a stem session.');
      }
      return;
    }
    if (!ready || !(response instanceof ArrayBuffer) || response.byteLength !== stemHeaderBytes + hop * stereoFrameBytes
        || new DataView(response).getUint32(0, true) !== expectedFrame) {
      fail('Stem audio arrived out of order.');
      return;
    }
    expectedFrame += hop;
    port.postMessage({ type: 'vocals', buffer: response } satisfies PCMMessage, [response]);
  };

  port.onmessage = ({ data }: MessageEvent<PCMMessage>) => {
    if (data.type === 'error') {
      fail(data.message);
    } else if (data.type === 'active') {
      self.postMessage(data);
    } else if (data.type === 'capture') {
      if (!ready || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) {
        fail('The local helper is falling behind.');
        return;
      }
      socket.send(data.buffer);
      port.postMessage({ type: 'recycle', buffer: data.buffer } satisfies PCMMessage, [data.buffer]);
    }
  };
};
