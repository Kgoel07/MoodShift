"""Wire constants shared by the stem helper and the paced link benchmark."""

import struct

PACKET_FRAMES = 2048
HEADER = struct.Struct("<I")
PACKET_BYTES = HEADER.size + PACKET_FRAMES * 8
SUPPORTED_RATES = (44100, 48000)
HOP_SECONDS = 1.84
