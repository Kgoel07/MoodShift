"""KUIELab MDX-Net vocal inference and overlapping PCM windows."""

import hashlib
import math
import sys
import time

import numpy as np
import onnxruntime as ort
from scipy.fft import irfft, rfft
from scipy.signal import resample_poly


RATE = 44_100
FFT = 6144
FFT_HOP = 1024
FREQUENCIES = 2048
MODEL_HASH = "daba83c2ee1afee9139766ad64c9b6808d6b6f092fff04bed3338be50baac721"
WINDOW = np.hanning(FFT + 1)[:-1].astype(np.float32)


def execution_provider(device, platform=None):
    if device == "cpu":
        return "CPUExecutionProvider"
    platform = sys.platform if platform is None else platform
    if platform == "win32":
        return "DmlExecutionProvider"
    if platform.startswith("linux"):
        return "CUDAExecutionProvider"
    raise RuntimeError("Live stems require Windows DirectML or Linux NVIDIA CUDA.")


def stft(samples):
    padded = np.pad(samples, ((0, 0), (FFT // 2, FFT // 2)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, FFT, axis=1)
    return rfft(frames[:, ::FFT_HOP, :] * WINDOW, axis=-1)


def istft(spectra, frames):
    decoded = irfft(spectra, n=FFT, axis=-1) * WINDOW
    output = np.zeros((2, frames + FFT), dtype=np.float32)
    weights = np.zeros(frames + FFT, dtype=np.float32)
    for index in range(decoded.shape[1]):
        offset = index * FFT_HOP
        output[:, offset:offset + FFT] += decoded[:, index]
        weights[offset:offset + FFT] += WINDOW ** 2
    interior = slice(FFT // 2, FFT // 2 + frames)
    return output[:, interior] / weights[interior]


class VocalModel:
    def __init__(self, path, device):
        with path.open("rb") as source:
            checksum = hashlib.file_digest(source, "sha256").hexdigest()
        if checksum != MODEL_HASH:
            raise ValueError("Model checksum does not match the upstream KUIELab checkpoint.")
        provider = execution_provider(device)
        if provider not in ort.get_available_providers():
            raise RuntimeError(f"{provider} unavailable: {ort.get_available_providers()}")
        if provider == "CUDAExecutionProvider":
            # Load the pinned CUDA and cuDNN libraries installed in this venv.
            ort.preload_dlls(directory="")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.enable_mem_pattern = device == "cpu"
        providers = [provider] if device == "cpu" else [(provider, {"device_id": device})]
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=providers)
        if self.session.get_providers()[:1] != [provider]:
            raise RuntimeError(f"Requested {provider}, got {self.session.get_providers()}")
        self.session.disable_fallback()
        model_input = self.session.get_inputs()[0]
        _, channels, bins, steps = model_input.shape
        if channels != 4 or bins != FREQUENCIES or not isinstance(steps, int):
            raise ValueError(f"Unexpected model shape: {model_input.shape}")
        self.name = model_input.name
        self.shape = model_input.shape
        self.steps = steps
        self.frames = FFT_HOP * (steps - 1)
        self.last_inference_seconds = 0.0

    def vocals(self, samples):
        # Keep zero context on both sides of a short window inside the native model frame.
        before = (self.frames - samples.shape[1]) // 2
        after = self.frames - samples.shape[1] - before
        if min(before, after) < FFT // 2:
            raise ValueError("Window leaves too little context in the model frame.")
        padded = np.pad(samples, ((0, 0), (before, after)))
        spectrum = stft(padded)[:, :, :FREQUENCIES]
        features = np.stack((spectrum.real, spectrum.imag), axis=1)
        features = np.ascontiguousarray(features.reshape(1, 4, self.steps, FREQUENCIES).swapaxes(2, 3))
        started = time.perf_counter()
        prediction = self.session.run(None, {self.name: features})[0][0]
        self.last_inference_seconds = time.perf_counter() - started
        estimates = (prediction[::2] + 1j * prediction[1::2]).swapaxes(1, 2)
        spectrum = np.pad(estimates, ((0, 0), (0, 0), (0, FFT // 2 + 1 - FREQUENCIES)))
        return istft(spectrum, self.frames)[:, before:before + samples.shape[1]]


class WindowVocal:
    def __init__(self, model, rate, hop, overlap):
        self.model = model
        self.rate = rate
        self.hop = hop
        self.overlap = overlap
        self.fade = np.linspace(0.0, 1.0, overlap, dtype=np.float32)[None, :]
        self.previous_tail = None

    def predict(self, samples):
        divisor = math.gcd(RATE, self.rate)
        model_input = resample_poly(samples, RATE // divisor, self.rate // divisor, axis=1, padtype="line")
        vocals = self.model(model_input)
        vocals = resample_poly(vocals, self.rate // divisor, RATE // divisor, axis=1, padtype="line")[:, :samples.shape[1]]
        if vocals.shape != samples.shape or not np.isfinite(vocals).all():
            raise ValueError("Separator returned invalid samples.")
        if self.previous_tail is not None:
            vocals[:, :self.overlap] = self.previous_tail * (1 - self.fade) + vocals[:, :self.overlap] * self.fade
        self.previous_tail = vocals[:, self.hop:].copy()
        return vocals[:, :self.hop]
