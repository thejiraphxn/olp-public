# Local Whisper Server

OpenAI-compatible transcription API backed by [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper). Drop-in replacement for the Groq / OpenAI Whisper API the backend (`backend/src/jobs/transcribe.ts`) talks to.

- One Python process, FastAPI + uvicorn.
- Model loaded once at startup, shared across requests.
- Concurrent inferences gated by an asyncio semaphore (default 2).
- Faster-whisper releases the GIL during inference, so multiple requests run in parallel on a thread pool.

## Requirements

- Python 3.10+
- `ffmpeg` on `PATH` (faster-whisper uses it to decode audio)
- ~3 GB free RAM for `large-v3` at `int8` (CPU)

## First-time setup (venv)

```bash
cd whisper-server
python3 -m venv venv
source venv/bin/activate                 # Windows: venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env                     # edit if you want to tune
```

## Run

```bash
# from inside the activated venv
python server.py
# or, with auto-reload during development:
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

The first boot downloads the model (~1.5 GB for `large-v3` int8) into
`~/.cache/faster-whisper`. Subsequent boots are instant.

Verify:
```bash
curl http://localhost:8000/health
```

## Connect the backend to it

In `backend/.env` (local dev) or your production env, point Whisper at the local server:

```env
WHISPER_API_BASE_URL=http://localhost:8000/v1
WHISPER_API_KEY=any-non-empty-string             # only validated if WHISPER_SERVER_API_KEY is set
WHISPER_MODEL=large-v3
WHISPER_MAX_UPLOAD_MB=200
```

Then restart the backend. From now on, `transcribe.ts` will hit the local server instead of Groq.

## Concurrency, capacity, and scaling

This server is sized for **1–5 concurrent users** out of the box. Tune as needed.

### What controls concurrency

| Knob | Default | Effect |
|---|---|---|
| `WHISPER_MAX_CONCURRENT` | `2` | Cap on simultaneous inferences in this process. RAM-bound. |
| `UVICORN_WORKERS` | `1` | Process count. Each worker loads its own model copy. RAM scales linearly. |
| `WHISPER_BEAM_SIZE` | `5` | Decoder beam width. Lower = faster, lower quality. |

### How to grow

| Need | Do this |
|---|---|
| Demo, low-RAM laptop (Mac, 8 GB) | `MODEL_SIZE=large-v3`, `COMPUTE_TYPE=int8`, `MAX_CONCURRENT=2`. (Default.) |
| 5–10 users on a single 16 GB box | Bump `MAX_CONCURRENT=4`. Same model + compute type. |
| 10+ users, GPU available | `DEVICE=cuda`, `COMPUTE_TYPE=float16`, `MAX_CONCURRENT=8+`. |
| Multiple physical hosts | Run this server on each, put a load balancer (nginx/haproxy) in front. |
| Asynchronous backlog (jobs not realtime) | Put a Redis queue between backend and this server; run multiple instances as workers. |

> Multiple uvicorn `--workers` each load their own model, so RAM use is `workers × (model + activations)`. Don't bump workers past 1 on a low-RAM machine.

## Models

Default is `large-v3`. Other options (set `WHISPER_MODEL_SIZE`):

| Model | Quality | RAM @ int8 | Speed (CPU realtime factor) |
|---|---|---|---|
| `tiny` | poor | ~75 MB | 10×+ |
| `base` | usable for English | ~150 MB | 6× |
| `small` | OK multilingual | ~500 MB | 3× |
| `medium` | good multilingual | ~1.5 GB | 1.5× |
| `large-v3` | best | ~3 GB | 0.5–1× |

For Thai-language content, anything below `medium` will be noticeably worse — keep `large-v3` if RAM allows.

### Production note: original Whisper vs faster-whisper

`faster-whisper` uses CTranslate2 — typically 2–4× faster than the original `openai/whisper` Python package at similar quality. We default to it everywhere.

If you want the **reference Whisper** (slower, higher RAM, identical model weights), it's straightforward to swap: replace the `from faster_whisper import WhisperModel` block with `import whisper` and call `whisper.load_model("large-v3").transcribe(path)`. Useful for debugging output discrepancies, not recommended for serving.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness + config snapshot |
| `GET` | `/v1/models` | OpenAI-compatible model listing |
| `POST` | `/v1/audio/transcriptions` | OpenAI-compatible transcription |

`/v1/audio/transcriptions` accepts the same multipart fields as the OpenAI API:
- `file` (required) — audio blob
- `model` — accepted for compatibility, ignored (we always use the configured model)
- `language` — ISO code, e.g. `th`, `en`. Omit to autodetect.
- `response_format` — `verbose_json` (default), `json`, or `text`
- `temperature` — sampling temperature
- `timestamp_granularities[]` — pass `word` to also get per-word timestamps (slower)
- `prompt` — initial prompt to bias decoding

Returns `verbose_json` with `language`, `duration`, `text`, and `segments` matching OpenAI's shape.

## Troubleshooting

**"libcudnn / libcublas not found"** — you're trying to use CUDA without the CUDA libs. Either install them or set `WHISPER_DEVICE=cpu`.

**"Model download is slow / fails"** — the model lives on Hugging Face. Set `HF_HUB_OFFLINE=1` after the first successful download to skip update checks, or pre-download with `huggingface-cli download Systran/faster-whisper-large-v3`.

**"OOM during transcription"** — drop `MAX_CONCURRENT` to 1 first. If that doesn't help, switch to `medium` or `small`.

**Apple Silicon Mac is slow** — there's no Metal/MPS backend in CTranslate2 yet. CPU + `int8` is the best you'll get; ~0.5–1× realtime on M1/M2 for `large-v3`.

## Daemonize (optional)

Quick systemd unit for production:

```ini
# /etc/systemd/system/whisper-server.service
[Unit]
Description=Local Whisper Server
After=network.target

[Service]
WorkingDirectory=/path/to/online-education/whisper-server
EnvironmentFile=/path/to/online-education/whisper-server/.env
ExecStart=/path/to/online-education/whisper-server/venv/bin/python server.py
Restart=on-failure
User=whisper

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-server
journalctl -u whisper-server -f          # follow logs
```
