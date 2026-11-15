"""Local, paced feasibility check for KUIELab's ONNX vocal model."""

import argparse
import json
import math
import time
from collections import deque
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import onnxruntime as ort
import psutil
from scipy.signal import resample_poly
import soundfile as sf


from stem_model import RATE, VocalModel, WindowVocal, istft, stft

MAX_LAG = 3.0


def read_stereo(path):
    pcm, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    if pcm.shape[1] == 1:
        pcm = np.repeat(pcm, 2, axis=1)
    if pcm.shape[1] != 2:
        raise ValueError("Use a mono or stereo audio fixture.")
    divisor = math.gcd(RATE, sample_rate)
    return resample_poly(pcm.T, RATE // divisor, sample_rate // divisor, axis=1), sample_rate


def windows(samples, predict, hop, overlap, start=None):
    width = hop + overlap
    if not 0 < overlap < hop or width > samples.shape[1]:
        raise ValueError("Source must be at least the window length, with overlap smaller than the hop.")
    separator = WindowVocal(predict, RATE, hop, overlap)
    paced = start is not None
    start = start if paced else time.perf_counter()
    for offset in range(0, samples.shape[1], hop):
        chunk = samples[:, offset:offset + width]
        arrived = (offset + chunk.shape[1]) / RATE
        if paced:
            time.sleep(max(0, start + arrived - time.perf_counter()))
        before = time.perf_counter()
        padded = np.pad(chunk, ((0, 0), (0, width - chunk.shape[1])))
        predicted = separator.predict(padded)
        finished = time.perf_counter()
        count = min(hop, chunk.shape[1])
        yield offset, predicted[:, :count].copy(), finished - before, finished - start


def stream_integrity():
    rng = np.random.default_rng(20261114)
    stereo = rng.uniform(-0.1, 0.1, (2, 24_017)).astype(np.float32)
    reconstructed = istft(stft(stereo), stereo.shape[1])
    np.testing.assert_allclose(stereo, reconstructed, rtol=1e-5, atol=1e-6)
    chunks = list(windows(stereo, np.copy, 4096, 555))
    assert [offset for offset, *_ in chunks] == list(range(0, stereo.shape[1], 4096))
    np.testing.assert_allclose(np.concatenate([chunk for _, chunk, *_ in chunks], axis=1), stereo,
                               rtol=1e-6, atol=1e-7)
    print("Synthetic stereo STFT and ordered overlap/tail integrity passed.", flush=True)


def gain_db(samples):
    return float(20 * np.log10(max(1e-12, np.sqrt(np.mean(samples**2)))))


def reference_scores(vocal, backing, estimated_vocal, estimated_backing):
    references = np.stack((vocal.ravel(), backing.ravel()), axis=1).astype(np.float64)
    estimates = np.stack((estimated_vocal.ravel(), estimated_backing.ravel()), axis=1)
    coefficients = np.linalg.lstsq(references, estimates, rcond=None)[0]
    levels = 20 * np.log10(np.maximum(np.abs(coefficients), 1e-8))
    return {
        "vocals_in_vocals_db": levels[0, 0],
        "vocals_in_instrumental_db": levels[0, 1],
        "backing_in_vocals_db": levels[1, 0],
        "backing_in_instrumental_db": levels[1, 1],
    }


class DevicePlayout:
    """Consume real PCM buffers in the device callback and record DAC timestamps."""

    def __init__(self, device, source_length, delay):
        import sounddevice as sd

        self.queue = deque()
        self.source_length = source_length
        self.delay = delay
        self.read_offset = 0
        self.first_lag = None
        self.missing_frames = 0
        self.output_underflows = 0
        self.dac_start = None
        self.stream = sd.OutputStream(device=device, samplerate=RATE, channels=2, dtype="float32",
                                      extra_settings=sd.WasapiSettings(auto_convert=True),
                                      callback=self.consume)

    def start(self):
        self.dac_start = self.stream.time + 0.1
        return time.perf_counter() + 0.1

    def consume(self, output, frames, clock, status):
        output.fill(0)
        if self.dac_start is None or self.read_offset >= self.source_length:
            return
        until_start = self.dac_start + self.delay - clock.outputBufferDacTime
        begin = min(frames, max(0, math.ceil(until_start * RATE)))
        if begin == frames:
            return
        if status.output_underflow:
            self.output_underflows += 1
        requested = min(frames - begin, self.source_length - self.read_offset)
        end = self.read_offset + requested
        while self.read_offset < end:
            if not self.queue:
                self.missing_frames += end - self.read_offset
                self.read_offset = end
                return
            offset, samples = self.queue[0]
            if offset + len(samples) <= self.read_offset:
                self.queue.popleft()
                continue
            count = min(end - self.read_offset, max(0, offset - self.read_offset))
            if count:
                self.missing_frames += count
            else:
                index = self.read_offset - offset
                count = min(end - self.read_offset, len(samples) - index)
                output[begin:begin + count] = samples[index:index + count]
                if self.first_lag is None:
                    self.first_lag = (clock.outputBufferDacTime - self.dac_start
                                      + (begin - self.read_offset) / RATE)
            begin += count
            self.read_offset += count

    def finish(self):
        deadline = time.perf_counter() + self.delay + 1
        while self.read_offset < self.source_length and time.perf_counter() < deadline:
            time.sleep(0.025)
        if self.read_offset < self.source_length:
            raise RuntimeError("Audio device did not consume the full excerpt.")


def run(model, mixture, hop, overlap, delay, playout=None):
    timings = []
    inference = []
    ready_lags = []
    stems = []
    underruns = 0
    queue = deque(maxlen=3)
    peak_queued = 0
    started = playout.start() if playout else time.perf_counter()
    process = psutil.Process()
    peak_ram = process.memory_info().rss
    for offset, vocal, wall_time, ready in windows(mixture, model.vocals, hop, overlap,
                                                   start=started if delay is not None else None):
        timings.append(wall_time)
        inference.append(model.last_inference_seconds)
        peak_ram = max(peak_ram, process.memory_info().rss)
        if delay is not None:
            timestamp = offset / RATE
            ready_lags.append(ready - timestamp)
            while queue and queue[0] <= ready:
                queue.popleft()
            playback_time = timestamp + delay
            if ready > playback_time:
                underruns += 1
            elif len(queue) == queue.maxlen:
                raise RuntimeError("Playout queue exceeded its bound.")
            else:
                queue.append(playback_time)
                peak_queued = max(peak_queued, len(queue))
        stems.append(vocal)
        if playout:
            if len(playout.queue) >= 3:
                raise RuntimeError("Audio device queue exceeded its bound.")
            playout.queue.append((offset, np.ascontiguousarray(vocal.T)))
    if playout:
        playout.finish()
    wall = time.perf_counter() - started
    vocals = np.concatenate(stems, axis=1)
    accompaniment = mixture - vocals
    results = {
        "source_s": mixture.shape[1] / RATE,
        "wall_s": wall,
        "windows": len(timings),
        "hop_s": hop / RATE,
        "processing_median_s": float(np.median(timings)),
        "processing_p95_s": float(np.percentile(timings, 95)),
        "processing_max_s": max(timings),
        "onnx_inference_median_s": float(np.median(inference)),
        "onnx_inference_p95_s": float(np.percentile(inference, 95)),
        "onnx_inference_max_s": max(inference),
        "audio_seconds_per_processing_second": mixture.shape[1] / RATE / sum(timings),
        "peak_sampled_rss_mib": peak_ram / 1024**2,
        "mix_rms_dbfs": gain_db(mixture),
        "vocals_rms_dbfs": gain_db(vocals),
        "accompaniment_rms_dbfs": gain_db(accompaniment),
        "reconstruction_error": float(np.max(np.abs(mixture - (vocals + accompaniment)))),
    }
    if delay is not None:
        results.update({
            "scheduled_delay_s": delay,
            "ready_latency_median_s": float(np.median(ready_lags)),
            "ready_latency_max_s": max(ready_lags),
            "software_playout_deadline_misses": underruns,
            "peak_queued_chunks": peak_queued,
        })
    if playout:
        results.update({
            "input_timestamp_to_first_DAC_s": playout.first_lag,
            "missing_device_frames": playout.missing_frames,
            "device_underflows": playout.output_underflows,
        })
    return vocals, accompaniment, results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path, nargs="?")
    parser.add_argument("--model", type=Path, default=Path(".stem-gate/assets/vocals.onnx"))
    parser.add_argument("--device", default="0", help="DirectML or CUDA device index, or cpu for an offline comparison")
    parser.add_argument("--offset", type=float, default=15)
    parser.add_argument("--seconds", type=float, default=24)
    parser.add_argument("--window", type=float, default=2)
    parser.add_argument("--overlap", type=float, default=0.16)
    parser.add_argument("--delay", type=float, help="Pace real-time input and test this software playout deadline")
    parser.add_argument("--play-device", type=int, help="Optional Windows WASAPI output device index for DAC timing")
    parser.add_argument("--require-realtime", action="store_true", help="Fail on a missed deadline, inference over 650 ms, or throughput at/below 1x")
    parser.add_argument("--reference-vocals", type=Path, help="Mix these isolated vocals over the instrumental fixture")
    parser.add_argument("--output", type=Path, help="Write the authorized fixture excerpt and its two stems as WAV")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        stream_integrity()
        return
    if args.fixture is None:
        parser.error("specify an authorized local fixture")
    if args.delay is not None and not 0 < args.delay <= MAX_LAG:
        parser.error(f"--delay must be between zero and {MAX_LAG} seconds")
    if args.play_device is not None and args.delay is None:
        parser.error("--play-device requires --delay")
    if args.require_realtime and args.delay is None:
        parser.error("--require-realtime requires --delay")
    pcm, source_rate = read_stereo(args.fixture)
    start = round(args.offset * RATE)
    count = round(args.seconds * RATE)
    if start < 0 or count <= 0 or start + count > pcm.shape[1]:
        parser.error("requested excerpt is outside the audio fixture")
    mixture = pcm[:, start:start + count]
    if args.reference_vocals:
        vocal_reference, _ = read_stereo(args.reference_vocals)
        if vocal_reference.shape[1] < count:
            parser.error("isolated vocal reference is shorter than the requested excerpt")
        vocal_reference = vocal_reference[:, :count]
        # Equalize reference RMS and leave headroom without changing the spectral balance.
        vocal_reference = vocal_reference * (0.06 / np.sqrt(np.mean(vocal_reference ** 2)))
        backing_reference = mixture * (0.06 / np.sqrt(np.mean(mixture ** 2)))
        mixture = vocal_reference + backing_reference
    overlap = round(args.overlap * RATE)
    hop = round(args.window * RATE) - overlap
    load = time.perf_counter()
    model = VocalModel(args.model, args.device)
    load_seconds = time.perf_counter() - load
    warmup = time.perf_counter()
    model.vocals(np.zeros((2, hop + overlap), dtype=np.float32))
    report = {
        "onnxruntime": ort.__version__,
        "providers": model.session.get_providers(),
        "device": args.device,
        "load_s": load_seconds,
        "warmup_s": time.perf_counter() - warmup,
        "model_shape": model.shape,
        "native_window_s": model.frames / RATE,
        "input_rate": source_rate,
        "model_rate": RATE,
        "window_s": (hop + overlap) / RATE,
        "overlap_s": overlap / RATE,
        "available_ram_mib": psutil.virtual_memory().available / 1024**2,
    }
    print(json.dumps(report), flush=True)
    playout = DevicePlayout(args.play_device, count, args.delay) if args.play_device is not None else None
    with playout.stream if playout else nullcontext():
        vocals, instrumental, report = run(model, mixture, hop, overlap, args.delay, playout)
    if args.reference_vocals:
        report.update(reference_scores(vocal_reference, backing_reference, vocals, instrumental))
    print(json.dumps(report, indent=2), flush=True)
    if args.require_realtime and (report["software_playout_deadline_misses"] or report["processing_max_s"] > 0.65
                                  or report["audio_seconds_per_processing_second"] <= 1):
        raise SystemExit("FAIL: inference or playout missed the real-time gate.")
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        for name, samples in [("mix", mixture), ("vocals", vocals), ("instrumental", instrumental)]:
            sf.write(args.output / f"{name}.wav", samples.T, RATE, subtype="FLOAT")


if __name__ == "__main__":
    main()
