export const stemPacketFrames = 2048;
export const stemHeaderBytes = 4;
export const stereoFrameBytes = 8;

export type PCMMessage =
  | { type: 'capture' | 'recycle' | 'vocals'; buffer: ArrayBuffer }
  | { type: 'start' | 'active' }
  | { type: 'error'; message: string };

export interface StemWorkerStart {
  port: MessagePort;
  sampleRate: number;
  sessionId: string;
  demoCode?: string;
}
