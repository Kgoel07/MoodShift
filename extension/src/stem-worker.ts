import { stemHeaderBytes, stereoFrameBytes, type PCMMessage, type StemWorkerStart } from './shared/stem-pcm';
import { deployment } from './shared/deployment';
import { stemStartMessage } from './api-client';

self.onmessage = ({ data }: MessageEvent<StemWorkerStart>) => {
  const { port, sampleRate, sessionId, demoCode } = data;
  const hello = stemStartMessage(sampleRate, sessionId, deployment, demoCode);
  const socket = new WebSocket(deployment.stemWsUrl);
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

  socket.onopen = () => socket.send(JSON.stringify(hello));
  socket.onerror = () => fail(deployment.mode === 'development' ? 'Start the local stem helper for this extension.' : 'Could not connect to the cloud stem worker.');
  socket.onclose = event => fail(event.reason || 'Stem helper disconnected.');
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
        fail('The helper could not establish a stem session.');
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
        fail('The stem helper is falling behind.');
        return;
      }
      socket.send(data.buffer);
      port.postMessage({ type: 'recycle', buffer: data.buffer } satisfies PCMMessage, [data.buffer]);
    }
  };
};
