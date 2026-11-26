#!/usr/bin/env python3
"""Keep the Habibi unified model loaded and speak with the owner's reference clips.

The dashboard (in Docker) calls POST /speak. One request at a time: the model is not
safe to run twice at once on Apple's GPU.
"""

import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from f5_tts.infer.utils_infer import load_model, load_vocoder, preprocess_ref_audio_text
from hydra.utils import get_class
from importlib.resources import files
from omegaconf import OmegaConf

from habibi_tts.infer.utils_infer import infer_process, nfe_step
from habibi_tts.model.utils import dialect_id_map

ROOT = Path(os.environ.get("HABIBI_DATA", Path(__file__).resolve().parents[2] / "data"))
CKPT = ROOT / "habibi" / "Unified" / "model_200000.safetensors"
VOCAB = ROOT / "habibi" / "Unified" / "vocab.txt"
MANIFEST = ROOT / "voices" / "habibi" / "clips.json"
CLIPS = ROOT / "voices" / "habibi" / "clips"
PORT = int(os.environ.get("HABIBI_PORT", "8091"))
DEVICE = os.environ.get("HABIBI_DEVICE") or (
    "mps" if torch.backends.mps.is_available() else "cpu"
)
STEPS = int(os.environ.get("HABIBI_NFE", str(nfe_step)))

lock = threading.Lock()
voices = {}
model = None
vocoder = None
mel_spec_type = "vocos"


def load():
    global model, vocoder, mel_spec_type
    if not CKPT.is_file() or not VOCAB.is_file():
        raise SystemExit(f"Habibi weights missing in {CKPT.parent}")
    if not MANIFEST.is_file():
        raise SystemExit(f"Voice clips missing: {MANIFEST}")
    spec = json.loads(MANIFEST.read_text())
    cfg = OmegaConf.load(files("f5_tts").joinpath("configs/F5TTS_v1_Base.yaml"))
    model_cls = get_class(f"f5_tts.model.{cfg.model.backbone}")
    mel_spec_type = cfg.model.mel_spec.mel_spec_type
    print(f"[habibi] loading model on {DEVICE}", flush=True)
    model = load_model(
        model_cls,
        cfg.model.arch,
        str(CKPT),
        mel_spec_type=mel_spec_type,
        vocab_file=str(VOCAB),
        device=DEVICE,
    )
    vocoder = load_vocoder(vocoder_name=mel_spec_type, is_local=False, local_path="", device=DEVICE)
    for style, clip in spec.items():
        if style == "laugh" or not clip.get("text"):
            continue
        audio = CLIPS / clip["file"]
        if not audio.is_file():
            print(f"[habibi] skip {style}: {audio} missing", flush=True)
            continue
        ref_audio, ref_text = preprocess_ref_audio_text(str(audio), clip["text"])
        dialect = clip.get("dialect", "LEV")
        voices[style] = {
            "ref_audio": ref_audio,
            "ref_text": ref_text,
            "dialect_id": dialect_id_map.get(dialect, dialect_id_map["LEV"]),
        }
        print(f"[habibi] clip {style} ({dialect})", flush=True)
    if "calm" not in voices:
        raise SystemExit("The calm reference clip is required")
    print(f"[habibi] ready on 127.0.0.1:{PORT} styles={list(voices)}", flush=True)


def synthesize(text, style, speed):
    voice = voices.get(style) or voices["calm"]
    audio, sample_rate, _ = infer_process(
        voice["ref_audio"],
        voice["ref_text"],
        text,
        model,
        vocoder,
        mel_spec_type=mel_spec_type,
        nfe_step=STEPS,
        speed=float(speed or 1),
        device=DEVICE,
        dialect_id=voice["dialect_id"],
        show_info=lambda *_: None,
        progress=None,
    )
    if audio is None or len(audio) == 0:
        raise RuntimeError("Habibi returned silence")
    return np.asarray(audio, dtype=np.float32), int(sample_rate)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[habibi] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            return self._send(404, b"not found", "text/plain")
        body = json.dumps({"ok": True, "device": DEVICE, "styles": list(voices)}).encode()
        self._send(200, body, "application/json")

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/speak":
            return self._send(404, b"not found", "text/plain")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text") or "").strip()
            if not text:
                return self._send(400, b"text is required", "text/plain")
            style = str(req.get("style") or "calm")
            speed = min(1.6, max(0.6, float(req.get("speed") or 1)))
            with lock:
                audio, sample_rate = synthesize(text[:1200], style, speed)
            import io
            buf = io.BytesIO()
            sf.write(buf, audio, sample_rate, format="WAV")
            self._send(200, buf.getvalue(), "audio/wav")
        except Exception as err:
            traceback.print_exc()
            self._send(500, str(err).encode(), "text/plain")

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    # Vocoder weights download once into the Hugging Face cache next to the model.
    os.environ.setdefault("HF_HOME", str(ROOT / "habibi" / "cache"))
    load()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
