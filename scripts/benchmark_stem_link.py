"""Measure paced fixture PCM, WebSocket RTT and playout deadlines from the listener's machine."""

import argparse
import getpass
import json
import math
import re
import threading
import time
import uuid
from urllib.parse import urlsplit

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

from .stem_protocol import HEADER, HOP_SECONDS, PACKET_FRAMES, SUPPORTED_RATES


def run(url, origin, samples, rate, delay, token=None):
    hop = round(rate * HOP_SECONDS)
    sample_count = len(samples) // PACKET_FRAMES * PACKET_FRAMES
    expected = max(0, 1 + (sample_count - 2 * rate) // hop)
    if not expected:
        raise ValueError("Use at least three seconds of fixture audio.")
    session = uuid.uuid4().hex
    lags = []
    rtts = []
    failures = []
    finished = threading.Event()
    with connect(url, origin=origin, compression=None, max_size=HEADER.size + hop * 8,
                 max_queue=(4, 2), open_timeout=5, close_timeout=1) as connection:
        hello = {"type": "start", "sampleRate": rate, "sessionId": session}
        if token is not None:
            hello["token"] = token
        connection.send(json.dumps(hello))
        if json.loads(connection.recv(timeout=5)) != {"type": "ready", "sessionId": session, "hop": hop}:
            raise ValueError("The helper returned an unexpected startup message.")
        started = time.perf_counter()

        def receive():
            try:
                for index in range(expected):
                    packet = connection.recv(timeout=max(5, delay + 1))
                    arrived = time.perf_counter()
                    offset = index * hop
                    if (not isinstance(packet, bytes) or len(packet) != HEADER.size + hop * 8
                            or HEADER.unpack_from(packet)[0] != offset
                            or not np.isfinite(np.frombuffer(packet, "<f4", offset=HEADER.size)).all()):
                        raise ValueError("Invalid or out-of-order stem packet.")
                    lags.append(arrived - started - offset / rate)
            except (ValueError, TimeoutError, WebSocketException) as error:
                failures.append(error)
                finished.set()

        def ping():
            try:
                while not finished.is_set():
                    before = time.perf_counter()
                    if not connection.ping().wait(2) or connection.close_code is not None:
                        raise TimeoutError("WebSocket ping did not complete.")
                    rtts.append(time.perf_counter() - before)
                    finished.wait(5)
            except (TimeoutError, WebSocketException) as error:
                failures.append(error)
                finished.set()

        receiver = threading.Thread(target=receive, daemon=True)
        pinger = threading.Thread(target=ping, daemon=True)
        receiver.start()
        pinger.start()
        try:
            for offset in range(0, sample_count, PACKET_FRAMES):
                target = started + (offset + PACKET_FRAMES) / rate
                if finished.wait(max(0, target - time.perf_counter())):
                    break
                chunk = samples[offset:offset + PACKET_FRAMES]
                connection.send(HEADER.pack(offset) + chunk.astype("<f4", copy=False).tobytes())
            receiver.join(timeout=max(5, delay + 1))
        finally:
            finished.set()
            pinger.join(timeout=3)
        if failures:
            raise failures[0]
        if len(lags) != expected or not rtts:
            raise TimeoutError("Incomplete stem output or RTT measurements.")

    return {
        "input_audio_s": sample_count / rate,
        "wall_s": time.perf_counter() - started,
        "rate_hz": rate,
        "output_packets": len(lags),
        "buffer_s": delay,
        "deadline_misses": sum(lag > delay for lag in lags),
        "arrival_lag_p95_s": float(np.percentile(lags, 95)),
        "arrival_lag_max_s": max(lags),
        "max_interarrival_jitter_s": max((abs(b - a) for a, b in zip(lags, lags[1:])), default=0),
        "websocket_rtt_p95_s": float(np.percentile(rtts, 95)),
        "websocket_rtt_max_s": max(rtts),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture")
    parser.add_argument("--url", default="ws://127.0.0.1:8788")
    parser.add_argument("--origin", required=True, help="chrome-extension:// followed by the extension ID")
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--rate", type=int, choices=SUPPORTED_RATES, default=48000)
    parser.add_argument("--buffer", type=float, default=2.8)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if (url.scheme not in ("ws", "wss") or not url.hostname or url.username is not None
            or url.query or url.fragment or (url.scheme == "ws" and url.hostname != "127.0.0.1")):
        parser.error("Use loopback ws:// or secure wss:// with no credentials or query.")
    if (not re.fullmatch(r"chrome-extension://[a-p]{32}", args.origin)
            or not 3 <= args.seconds <= 600 or not 2.8 <= args.buffer <= 8):
        parser.error("Use an exact extension origin, 3–600 seconds of input and a 2.8–8 s buffer.")
    token = getpass.getpass("Private demo access code: ") if url.scheme == "wss" else None
    if token is not None and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        parser.error("Invalid private demo access code.")
    with sf.SoundFile(args.fixture) as audio:
        source_rate = audio.samplerate
        samples = audio.read(args.seconds * source_rate, dtype="float32", always_2d=True)
    if len(samples) != args.seconds * source_rate or samples.shape[1] not in (1, 2):
        parser.error("The fixture needs the requested duration and one or two channels.")
    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
    divisor = math.gcd(args.rate, source_rate)
    samples = resample_poly(samples, args.rate // divisor, source_rate // divisor, axis=0)
    try:
        result = run(args.url, args.origin, samples, args.rate, args.buffer, token)
    except (OSError, ValueError, TimeoutError, WebSocketException) as error:
        raise SystemExit(f"FAIL: stem link did not complete ({type(error).__name__}).") from None
    print(json.dumps(result, indent=2))
    if result["deadline_misses"]:
        raise SystemExit("FAIL: audio arrived after the configured buffer deadline.")


if __name__ == "__main__":
    main()
