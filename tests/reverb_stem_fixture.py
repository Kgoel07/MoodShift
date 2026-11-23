"""Test-only half-gain vocal packets. No separation model, inference, or GPU."""
import argparse
import json
import struct

import numpy as np
from websockets.sync.server import serve
from websockets.exceptions import ConnectionClosed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-id', required=True)
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()

    def connection(socket):
        try:
            hello = json.loads(socket.recv())
            rate = hello['sampleRate']
            if rate not in [44100, 48000] or hello['type'] != 'start':
                socket.close(); return
            hop = round(rate * 1.84)
            socket.send(json.dumps({'type': 'ready', 'sessionId': hello['sessionId'], 'hop': hop}))
            pending = np.empty((0, 2), dtype='<f4')
            expected = output = 0
            for packet in socket:
                if not isinstance(packet, bytes) or len(packet) != 4 + 2048 * 8 or struct.unpack_from('<I', packet)[0] != expected:
                    socket.close(); return
                expected += 2048
                pending = np.concatenate([pending, np.frombuffer(packet, '<f4', offset=4).reshape(-1, 2)])
                while len(pending) >= hop:
                    socket.send(struct.pack('<I', output) + (pending[:hop] * 0.5).astype('<f4').tobytes())
                    pending = pending[hop:]; output += hop
        except ConnectionClosed:
            pass

    with serve(connection, '127.0.0.1', args.port,
               origins=[f'chrome-extension://{args.extension_id}'], max_size=20000) as server:
        print('helper ready (TEST FIXTURE: no separation)', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
