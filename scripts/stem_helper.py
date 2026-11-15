"""Loopback-only MoodShift MDX-Net streaming helper."""

import argparse
import json
import re
import struct
import threading
import time
from pathlib import Path

import numpy as np
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

from .stem_model import VocalModel, WindowVocal

PACKET_FRAMES = 2048
HEADER = struct.Struct("<I")
PACKET_BYTES = HEADER.size + PACKET_FRAMES * 8
SUPPORTED_RATES = (44100, 48000)
PORT = 8788


class PCMStream:
    def __init__(self, predict, rate):
        self.hop = round(rate * 1.84)
        overlap = round(rate * 0.16)
        self.window = np.empty((2, self.hop + overlap), dtype=np.float32)
        self.filled = 0
        self.received = 0
        self.emitted = 0
        self.separator = WindowVocal(predict, rate, self.hop, overlap)

    def receive(self, packet):
        if not isinstance(packet, bytes) or len(packet) != PACKET_BYTES:
            raise ValueError("Invalid PCM frame.")
        offset, = HEADER.unpack_from(packet)
        if offset != self.received:
            raise ValueError("PCM frames arrived out of order.")
        samples = np.frombuffer(packet, dtype="<f4", offset=HEADER.size).reshape(-1, 2)
        if not np.isfinite(samples).all():
            raise ValueError("Invalid PCM samples.")
        self.received += len(samples)
        count = min(len(samples), self.window.shape[1] - self.filled)
        self.window[:, self.filled:self.filled + count] = samples[:count].T
        self.filled += count
        if self.filled < self.window.shape[1]:
            return None
        started = time.perf_counter()
        vocal = self.separator.predict(self.window)
        if time.perf_counter() - started > 0.65:
            raise TimeoutError("Separator could not meet the audio deadline.")
        result = HEADER.pack(self.emitted) + vocal.T.astype("<f4", copy=False).tobytes()
        self.emitted += self.hop
        overlap = self.window.shape[1] - self.hop
        self.window[:, :overlap] = self.window[:, self.hop:]
        self.window[:, overlap:overlap + len(samples) - count] = samples[count:].T
        self.filled = overlap + len(samples) - count
        return result


def serve_connection(connection, predict, busy):
    if not busy.acquire(blocking=False):
        connection.close(1013, "Another stem session is active.")
        return
    try:
        request = connection.recv(timeout=2)
        if not isinstance(request, str) or len(request) > 256:
            raise ValueError("Expected a start message.")
        hello = json.loads(request)
        if (not isinstance(hello, dict) or hello.get("type") != "start"
                or type(hello.get("sampleRate")) is not int or hello["sampleRate"] not in SUPPORTED_RATES):
            raise ValueError("Unsupported PCM setup.")
        session_id = hello.get("sessionId")
        if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
            raise ValueError("Invalid session ID.")
        stream = PCMStream(predict, hello["sampleRate"])
        connection.send(json.dumps({"type": "ready", "sessionId": session_id, "hop": stream.hop}))
        while True:
            response = stream.receive(connection.recv(timeout=3))
            if response is not None:
                connection.send(response)
    except ConnectionClosed:
        pass
    except ValueError:
        connection.close(1008, "Invalid stem session or PCM sequence.")
    except TimeoutError:
        connection.close(1013, "The separator missed its deadline. Try again.")
    except Exception:
        connection.close(1011, "Local separator failed.")
    finally:
        busy.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True, help="MoodShift ID from chrome://extensions")
    parser.add_argument("--model", type=Path, default=Path(".stem-gate/assets/vocals.onnx"))
    parser.add_argument("--device", type=int, default=1, help="DirectML adapter index")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("expected a 32-character Chrome extension ID")
    model = VocalModel(args.model, str(args.device))
    # Warm both browser sample rates and verify capacity before accepting audio.
    for rate in SUPPORTED_RATES:
        separator = PCMStream(model.vocals, rate).separator
        fixture = np.zeros((2, 2 * rate), dtype=np.float32)
        separator.predict(fixture)
        for _ in range(3):
            started = time.perf_counter()
            separator.predict(fixture)
            if time.perf_counter() - started > 0.55:
                parser.error(f"DirectML adapter {args.device} missed the startup deadline at {rate} Hz")
    busy = threading.Lock()
    with serve(lambda connection: serve_connection(connection, model.vocals, busy),
               "127.0.0.1", PORT, origins=[f"chrome-extension://{args.extension_id}"],
               compression=None, max_size=PACKET_BYTES, max_queue=(24, 8), close_timeout=0.5) as server:
        print(f"MoodShift stem helper ready on ws://127.0.0.1:{PORT} (DirectML adapter {args.device})", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
