"""Loopback-only MoodShift MDX-Net streaming helper."""

import argparse
import hmac
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from pathlib import Path

import numpy as np
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

from .stem_model import VocalModel, WindowVocal, execution_provider
from .stem_protocol import HEADER, HOP_SECONDS, PACKET_BYTES, PACKET_FRAMES, SUPPORTED_RATES

PORT = 8788
MAX_INFERENCE_SECONDS = 0.65


class PCMStream:
    def __init__(self, predict, rate):
        self.hop = round(rate * HOP_SECONDS)
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
        if time.perf_counter() - started > MAX_INFERENCE_SECONDS:
            raise TimeoutError("Separator could not meet the audio deadline.")
        result = HEADER.pack(self.emitted) + vocal.T.astype("<f4", copy=False).tobytes()
        self.emitted += self.hop
        overlap = self.window.shape[1] - self.hop
        self.window[:, :overlap] = self.window[:, self.hop:]
        self.window[:, overlap:overlap + len(samples) - count] = samples[count:].T
        self.filled = overlap + len(samples) - count
        return result


def serve_connection(connection, predict, busy, token=None, session_seconds=3600, stopping=None):
    acquired = False
    hard_stop = None
    try:
        if token is None:
            acquired = busy.acquire(blocking=False)
            if not acquired:
                connection.close(1013, "Another stem session is active.")
                return
        request = connection.recv(timeout=2)
        if not isinstance(request, str) or len(request) > 384:
            raise ValueError("Expected a start message.")
        hello = json.loads(request)
        if (not isinstance(hello, dict) or hello.get("type") != "start"
                or type(hello.get("sampleRate")) is not int or hello["sampleRate"] not in SUPPORTED_RATES):
            raise ValueError("Unsupported PCM setup.")
        session_id = hello.get("sessionId")
        if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
            raise ValueError("Invalid session ID.")
        if token is not None:
            supplied = hello.get("token")
            forwarded = connection.request.headers.get_all("X-Forwarded-Proto")
            if (forwarded != ["https"] or not isinstance(supplied, str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", supplied)
                    or not hmac.compare_digest(supplied, token)):
                connection.close(1008, "Stem access denied. Check the private demo code.")
                return
        elif "token" in hello:
            connection.close(1008, "The local stem helper does not use a demo code.")
            return
        if not acquired:
            acquired = busy.acquire(blocking=False)
        if not acquired:
            connection.close(1013, "Another stem session is active.")
            return
        deadline = time.monotonic() + session_seconds
        # Bound blocked socket writes even when the authenticated peer stops reading.
        def disconnect():
            try:
                connection.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        hard_stop = threading.Timer(session_seconds + 1, disconnect)
        hard_stop.daemon = True
        hard_stop.start()
        stream = PCMStream(predict, hello["sampleRate"])
        connection.send(json.dumps({"type": "ready", "sessionId": session_id, "hop": stream.hop}))
        while stopping is None or not stopping.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                connection.close(1000, "Stem session time limit reached. Select a stem to reconnect.")
                return
            try:
                packet = connection.recv(timeout=min(3, remaining))
            except TimeoutError:
                if remaining <= 3:
                    connection.close(1000, "Stem session time limit reached. Select a stem to reconnect.")
                else:
                    connection.close(1013, "The stem audio input timed out.")
                return
            response = stream.receive(packet)
            if response is not None:
                connection.send(response)
    except ConnectionClosed:
        pass
    except ValueError:
        connection.close(1008, "Invalid stem session or PCM sequence.")
    except TimeoutError:
        connection.close(1013, "The separator missed its deadline. Try again.")
    except Exception:
        connection.close(1011, "The stem separator failed.")
    finally:
        if hard_stop is not None:
            hard_stop.cancel()
        if acquired:
            busy.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", action="append", default=[], help="MoodShift ID from chrome://extensions (repeatable)")
    parser.add_argument("--model", type=Path, default=Path(".stem-gate/assets/vocals.onnx"))
    parser.add_argument("--device", type=int, default=1 if sys.platform == "win32" else 0, help="DirectML or CUDA device index")
    parser.add_argument("--mode", choices=("local", "cloud"), default=os.getenv("STEM_DEPLOYMENT", "local"))
    parser.add_argument("--session-seconds", type=int, default=os.getenv("STEM_SESSION_SECONDS"),
                        help="Maximum active session duration (30–3600 seconds)")
    args = parser.parse_args()
    origins = set(f"chrome-extension://{item}" for item in args.extension_id)
    supplied_origins = os.getenv("ALLOWED_EXTENSION_ORIGINS", "").strip()
    if supplied_origins:
        origins.update(item.strip() for item in supplied_origins.split(","))
    if not origins or any(not re.fullmatch(r"chrome-extension://[a-p]{32}", item) for item in origins):
        parser.error("configure exact Chrome extension IDs via --extension-id or ALLOWED_EXTENSION_ORIGINS")
    token = os.getenv("DEMO_ACCESS_TOKEN") if args.mode == "cloud" else None
    if args.mode == "cloud" and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token or ""):
        parser.error("cloud mode requires a 32–128 character URL-safe DEMO_ACCESS_TOKEN")
    session_seconds = args.session_seconds if args.session_seconds is not None else (900 if token else 3600)
    if not 30 <= session_seconds <= 3600 or args.device < 0:
        parser.error("expected a nonnegative device and a 30–3600 second session")
    provider = execution_provider(str(args.device))
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
                parser.error(f"{provider} device {args.device} missed the startup deadline at {rate} Hz")
    busy = threading.Lock()
    stopping = threading.Event()
    with serve(lambda connection: serve_connection(connection, model.vocals, busy, token, session_seconds, stopping),
               "127.0.0.1", PORT, origins=sorted(origins), open_timeout=3,
               ping_interval=15, ping_timeout=10, compression=None,
               max_size=PACKET_BYTES, max_queue=(24, 8), close_timeout=0.5) as server:
        print(f"MoodShift stem helper ready on loopback port {PORT} ({provider}, device {args.device}, {args.mode})", flush=True)
        # Shutdown from a different thread because serve_forever is running on the main thread.
        def stop(*_):
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            stopping.set()


if __name__ == "__main__":
    main()
