import json
import unittest
from unittest.mock import patch
from threading import Lock, Thread

import numpy as np
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect
from websockets.sync.server import serve

from scripts.stem_helper import HEADER, PACKET_FRAMES, PCMStream, serve_connection


def packet(start, rate=48000):
    offsets = np.arange(start, start + PACKET_FRAMES)
    signal = np.stack((0.1 * np.sin(440 * 2 * np.pi * offsets / rate),
                       0.1 * np.cos(740 * 2 * np.pi * offsets / rate)), axis=1)
    return HEADER.pack(start) + signal.astype("<f4").tobytes()


class StreamTests(unittest.TestCase):
    def test_overlap_order_stereo_and_sample_rate_conversion(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                stream = PCMStream(np.copy, rate)
                source = []
                output = []
                for start in range(0, rate * 6, PACKET_FRAMES):
                    frame = packet(start, rate)
                    source.append(np.frombuffer(frame, "<f4", offset=4))
                    result = stream.receive(frame)
                    if result:
                        self.assertEqual(HEADER.unpack_from(result)[0], len(output) * stream.hop)
                        output.append(np.frombuffer(result, "<f4", offset=4))
                self.assertEqual(len(output), 3)
                actual = np.concatenate(output)
                expected = np.concatenate(source)[:len(actual)]
                np.testing.assert_allclose(actual, expected, atol=0.003)
                self.assertLess(stream.filled, stream.window.shape[1])

    def test_invalid_or_late_frame_is_rejected(self):
        stream = PCMStream(np.copy, 44100)
        for frame in (packet(PACKET_FRAMES), b"short", HEADER.pack(0) + np.full(4096, np.nan, "<f4").tobytes()):
            with self.assertRaises(ValueError):
                stream.receive(frame)
        stream.receive(packet(0))
        with self.assertRaises(ValueError):
            stream.receive(packet(0))

    def test_inference_deadline(self):
        stream = PCMStream(np.copy, 44100)
        final_offset = (88200 // PACKET_FRAMES) * PACKET_FRAMES
        for start in range(0, final_offset, PACKET_FRAMES):
            stream.receive(packet(start))
        with patch("scripts.stem_helper.time.perf_counter", side_effect=[10, 11]):
            with self.assertRaises(TimeoutError):
                stream.receive(packet(final_offset))

    def test_loopback_origin_exclusivity_and_restart(self):
        origin = "chrome-extension://" + "a" * 32
        busy = Lock()
        handler = lambda connection: serve_connection(connection, np.copy, busy)
        with serve(handler, "127.0.0.1", 0, origins=[origin]) as server:
            runner = Thread(target=server.serve_forever)
            runner.start()
            url = f"ws://127.0.0.1:{server.socket.getsockname()[1]}"
            try:
                with self.assertRaises(InvalidStatus):
                    connect(url, origin="https://example.com")
                hello = {"type": "start", "sampleRate": 48000, "sessionId": "1" * 32}
                with connect(url, origin=origin) as client:
                    client.send(json.dumps(hello))
                    self.assertEqual(json.loads(client.recv(timeout=2))["sessionId"], hello["sessionId"])
                    with connect(url, origin=origin) as duplicate:
                        with self.assertRaises(ConnectionClosed):
                            duplicate.recv(timeout=2)
                    client.send(packet(PACKET_FRAMES))
                    with self.assertRaises(ConnectionClosed):
                        client.recv(timeout=2)
                # The rejected connection released its slot and a new sequence starts at zero.
                with connect(url, origin=origin) as client:
                    client.send(json.dumps({**hello, "sessionId": "2" * 32}))
                    self.assertEqual(json.loads(client.recv(timeout=2))["type"], "ready")
                    client.send(HEADER.pack(0) + bytes(PACKET_FRAMES * 8))
            finally:
                server.shutdown()
                runner.join(timeout=3)
