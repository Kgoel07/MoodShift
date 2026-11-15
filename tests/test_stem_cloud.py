import json
import unittest
from contextlib import contextmanager
from pathlib import Path
from threading import Lock, Thread
from unittest.mock import Mock, patch

import numpy as np
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect
from websockets.sync.server import serve

from scripts.benchmark_stem_link import run
from scripts.stem_helper import PCMStream, serve_connection
from scripts.stem_model import VocalModel, execution_provider

ORIGIN = "chrome-extension://" + "a" * 32
TOKEN = "unit-test-placeholder-" + "z" * 32
HELLO = {"type": "start", "sampleRate": 48000, "sessionId": "1" * 32}


@contextmanager
def socket_server(token=None, session_seconds=3600):
    busy = Lock()
    handler = lambda connection: serve_connection(connection, np.copy, busy, token, session_seconds)
    with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"ws://127.0.0.1:{server.socket.getsockname()[1]}"
        finally:
            server.shutdown()
            thread.join(timeout=3)


class CloudStemTests(unittest.TestCase):
    def test_dml_cuda_and_cpu_benchmark_platforms(self):
        self.assertEqual(execution_provider("1", "win32"), "DmlExecutionProvider")
        self.assertEqual(execution_provider("0", "linux"), "CUDAExecutionProvider")
        self.assertEqual(execution_provider("cpu", "darwin"), "CPUExecutionProvider")
        with self.assertRaises(RuntimeError):
            execution_provider("0", "darwin")

    def test_cuda_session_loads_pinned_libraries_and_refuses_cpu_fallback(self):
        session = Mock()
        session.get_inputs.return_value = [Mock(shape=[1, 4, 2048, 512])]
        session.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        checkpoint = Mock()
        checkpoint.hexdigest.return_value = "daba83c2ee1afee9139766ad64c9b6808d6b6f092fff04bed3338be50baac721"
        with patch("scripts.stem_model.execution_provider", return_value="CUDAExecutionProvider"), \
                patch("scripts.stem_model.hashlib.file_digest", return_value=checkpoint), \
                patch("scripts.stem_model.ort") as runtime:
            runtime.get_available_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            runtime.InferenceSession.return_value = session
            VocalModel(Path(__file__), "0")
            runtime.preload_dlls.assert_called_once_with(directory="")
            self.assertEqual(runtime.InferenceSession.call_args.kwargs["providers"],
                             [("CUDAExecutionProvider", {"device_id": "0"})])
            session.disable_fallback.assert_called_once()
            session.get_providers.return_value = ["CPUExecutionProvider"]
            with self.assertRaisesRegex(RuntimeError, "Requested CUDAExecutionProvider"):
                VocalModel(Path(__file__), "0")
            runtime.get_available_providers.return_value = ["CPUExecutionProvider"]
            with self.assertRaisesRegex(RuntimeError, "CUDAExecutionProvider unavailable"):
                VocalModel(Path(__file__), "0")

    def test_cloud_proxy_transport_token_origin_and_busy_order(self):
        with socket_server(TOKEN) as url, patch("scripts.stem_helper.PCMStream", wraps=PCMStream) as allocate:
            with self.assertRaises(InvalidStatus):
                connect(url, origin="https://example.com")
            for headers, token in [({}, TOKEN), ({"X-Forwarded-Proto": "http"}, TOKEN),
                                   ({"X-Forwarded-Proto": "https"}, None),
                                   ({"X-Forwarded-Proto": "https"}, "x" * 32)]:
                with connect(url, origin=ORIGIN, additional_headers=headers) as client:
                    client.send(json.dumps({**HELLO, "token": token}))
                    with self.assertRaisesRegex(ConnectionClosed, "Stem access denied"):
                        client.recv(timeout=2)
            allocate.assert_not_called()
            headers = {"X-Forwarded-Proto": "https"}
            with connect(url, origin=ORIGIN, additional_headers=headers) as first:
                first.send(json.dumps({**HELLO, "token": TOKEN}))
                self.assertEqual(json.loads(first.recv(timeout=2))["type"], "ready")
                with connect(url, origin=ORIGIN, additional_headers=headers) as duplicate:
                    duplicate.send(json.dumps({**HELLO, "token": TOKEN}))
                    with self.assertRaisesRegex(ConnectionClosed, "Another stem session"):
                        duplicate.recv(timeout=2)
                allocate.assert_called_once()

    def test_local_rejects_credentials_and_cloud_session_expires(self):
        with socket_server() as url, connect(url, origin=ORIGIN) as client:
            client.send(json.dumps({**HELLO, "token": TOKEN}))
            with self.assertRaisesRegex(ConnectionClosed, "does not use a demo code"):
                client.recv(timeout=2)
        with socket_server(TOKEN, session_seconds=0.12) as url:
            for _ in range(2):
                with connect(url, origin=ORIGIN, additional_headers={"X-Forwarded-Proto": "https"}) as client:
                    client.send(json.dumps({**HELLO, "token": TOKEN}))
                    self.assertEqual(json.loads(client.recv(timeout=2))["type"], "ready")
                    with self.assertRaisesRegex(ConnectionClosed, "session time limit"):
                        client.recv(timeout=2)

    def test_paced_link_benchmark_reports_latency_and_rtt(self):
        with socket_server() as url:
            stats = run(url, ORIGIN, np.zeros((48000 * 4, 2), dtype=np.float32), 48000, 2.8)
        self.assertEqual(stats["output_packets"], 2)
        self.assertEqual(stats["deadline_misses"], 0)
        self.assertGreater(stats["websocket_rtt_p95_s"], 0)
