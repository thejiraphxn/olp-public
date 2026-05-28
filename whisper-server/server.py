"""
Whisper FastAPI server.

Phase 2 role:
  Node hands off the mp3 + task_id via multipart POST /v1/tasks. We
  save the file to a temp path, return 202, and let BackgroundTasks
  drive the rest of the pipeline:

      TRANSCRIBING → save transcript → SUMMARIZING → save autoSummary +
      autoChapters → COMPLETED

  All status transitions and artifacts are written to Postgres directly
  (Prisma owns the schema; we just write the columns we need). Node
  never hears back — the UI polls /admin/tasks for state.

The legacy POST /v1/audio/transcriptions endpoint is preserved so the
synchronous flow still works if anything outside Node calls it.
"""
import asyncio
import os
import tempfile
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Optional

from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from faster_whisper import WhisperModel

# BatchedInferencePipeline landed in faster-whisper 1.1.0. If the venv
# still has 1.0.x for whatever reason, fall back to non-batched mode
# (slower but functional) instead of crashing the whole server at import.
try:
    from faster_whisper import BatchedInferencePipeline  # type: ignore
except ImportError:
    BatchedInferencePipeline = None  # type: ignore[assignment]

# Load .env BEFORE other imports that read env vars (logger_setup, db, etc.)
load_dotenv()

from logger_setup import setup_logging
from tasks import (
    TaskStatus,
    append_log,
    get_recording_id,
    mark_completed,
    mark_failed,
    save_auto_chapters,
    save_auto_summary,
    save_transcript,
    set_status,
    sweep_stuck_tasks,
    task_exists,
)
import db
from llm import close_client as llm_close_client
from llm import generate_chapters, healthcheck as llm_healthcheck, summarize
from s3_client import default_bucket as s3_default_bucket
from s3_client import download_to_file as s3_download_to_file
from s3_client import head_size as s3_head_size
from pydantic import BaseModel


# --------------------------------------------------------------------------
# Config (env-driven)
# --------------------------------------------------------------------------

MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "large-v3")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
DEVICE = os.getenv("WHISPER_DEVICE", "auto")
MODEL_CACHE = os.getenv(
    "WHISPER_MODEL_CACHE",
    str(Path.home() / ".cache" / "faster-whisper"),
)

def _env_int(name: str, default: str) -> int:
    """
    Tolerate inline-comment slip-ups in .env. python-dotenv reads the
    full value including any trailing `# comment`, so a line like
    `WHISPER_MIN_FREE_DISK_MB=1024   # disk guard` would otherwise crash
    on int(). Strip anything after the first `#` (or whitespace) and try.
    """
    raw = os.getenv(name, default) or default
    cleaned = raw.split("#", 1)[0].strip()
    try:
        return int(cleaned)
    except ValueError:
        # Fall back to the default if even the cleaned value is bad —
        # log so the operator sees it, but don't crash the service.
        import sys
        print(
            f"[config] {name}={raw!r} not a valid int, using default {default}",
            file=sys.stderr,
        )
        return int(default)


MAX_CONCURRENT = _env_int("WHISPER_MAX_CONCURRENT", "2")
MAX_UPLOAD_MB = _env_int("WHISPER_MAX_UPLOAD_MB", "200")
DEFAULT_LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None
DEFAULT_BEAM_SIZE = _env_int("WHISPER_BEAM_SIZE", "5")
# Reject new transcribe tasks when the host has less than this much free
# RAM (MB). Prevents the kernel OOM-killer from terminating uvicorn mid-
# job — refuse-fast and let the operator retry later instead.
MIN_FREE_MEMORY_MB = _env_int("WHISPER_MIN_FREE_MEMORY_MB", "1500")
# Performance knobs (CPU-only path)
# cpu_threads: ctranslate2 worker threads. 0 = let ctranslate2 pick (~num cores).
CPU_THREADS = _env_int("WHISPER_CPU_THREADS", "0")
# num_workers: how many parallel inferences the model can drive internally.
NUM_WORKERS = _env_int("WHISPER_NUM_WORKERS", "1")
# Batched pipeline — chunks long audio into ~30s slices and decodes in
# parallel batches. 3-5x faster on long clips. Off by default while we
# bake; flip ON via env once smoke-tested.
USE_BATCHED = (os.getenv("WHISPER_BATCHED", "false").split("#")[0].strip().lower()
               in ("1", "true", "yes"))
BATCH_SIZE = _env_int("WHISPER_BATCH_SIZE", "8")

API_KEY = os.getenv("WHISPER_SERVER_API_KEY") or None

CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGIN", "*").split(",") if o.strip()
]


# --------------------------------------------------------------------------
# Logging — rotating file at app.log + console
# --------------------------------------------------------------------------

log = setup_logging()


# --------------------------------------------------------------------------
# Model lifecycle (lazy, single instance, shared across requests)
# --------------------------------------------------------------------------

_model: Optional[WhisperModel] = None
# When WHISPER_BATCHED=true we wrap the base model in a BatchedInferencePipeline
# for the 3-5x speed-up on long audio. Pipeline holds a reference to the
# underlying model so we keep both around — `_model` for direct use,
# `_batched` for the fast path. Typed as Optional[Any] because the class
# may be None on old faster-whisper installs.
_batched: Optional[Any] = None
_model_lock = asyncio.Lock()
_inference_gate = asyncio.Semaphore(MAX_CONCURRENT)


async def _load_model() -> WhisperModel:
    """
    Load the configured Whisper model with retries. Network blips during
    the first download are surprisingly common; without a retry the
    service would crash on boot and systemd would loop until the
    StartLimitBurst trips, leaving it inactive until manual intervention.
    """
    log.info(
        "loading model %s (compute_type=%s, device=%s, cache=%s, cpu_threads=%s, num_workers=%s, batched=%s)",
        MODEL_SIZE,
        COMPUTE_TYPE,
        DEVICE,
        MODEL_CACHE,
        CPU_THREADS or "auto",
        NUM_WORKERS,
        USE_BATCHED,
    )
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            return await asyncio.to_thread(
                WhisperModel,
                MODEL_SIZE,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root=MODEL_CACHE,
                cpu_threads=CPU_THREADS,
                num_workers=NUM_WORKERS,
            )
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.exception(
                "model load failed (attempt %d/3): %s — retrying in %ds",
                attempt + 1,
                e,
                5 * (attempt + 1),
            )
            await asyncio.sleep(5 * (attempt + 1))
    assert last_err is not None
    log.error("model load failed after 3 attempts — service will fail health checks")
    raise last_err


async def get_model() -> WhisperModel:
    global _model, _batched
    if _model is None:
        async with _model_lock:
            if _model is None:
                _model = await _load_model()
                if USE_BATCHED:
                    if BatchedInferencePipeline is None:
                        log.warning(
                            "WHISPER_BATCHED=true but the installed faster-whisper "
                            "is < 1.1.0 — falling back to non-batched mode. "
                            "Run: pip install -U 'faster-whisper>=1.1.0'"
                        )
                    else:
                        _batched = BatchedInferencePipeline(model=_model)
                log.info("model ready")
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup steps are individually wrapped — a single failure shouldn't
    # prevent the service from coming up at all. /health?deep=true will
    # surface the failed subsystem so the operator can fix it without
    # being locked out of every endpoint.

    # 1) Postgres ping
    try:
        log.info("startup: pinging Postgres…")
        await db.ping()
        log.info("startup: ping ok")
    except Exception:  # noqa: BLE001
        log.exception(
            "startup: Postgres ping failed — service will start but all "
            "task endpoints will 500 until DB is reachable"
        )

    # 2) Sweep stuck tasks from previous boot
    try:
        swept = await sweep_stuck_tasks(
            max_age_minutes=_env_int("STUCK_TASK_MAX_AGE_MIN", "30")
        )
        if swept > 0:
            log.warning("startup: marked %d stuck tasks as FAILED", swept)
    except Exception:  # noqa: BLE001
        log.exception("startup: sweep_stuck_tasks failed — continuing")

    # 2.5) Reap orphan tmp files from previous crashes. If the process died
    # mid-transcribe, tmp mp3s linger in /tmp forever and slowly fill the disk.
    try:
        reaped = 0
        for p in Path(tempfile.gettempdir()).glob("olp-*"):
            try:
                p.unlink(missing_ok=True)
                reaped += 1
            except Exception:  # noqa: BLE001
                pass
        if reaped:
            log.info("startup: reaped %d orphan tmp files", reaped)
    except Exception:  # noqa: BLE001
        log.exception("startup: tmp reaper failed — continuing")

    # 3) Preload model (skipped under lazy mode)
    if os.getenv("WHISPER_LAZY_LOAD", "false").lower() not in ("1", "true", "yes"):
        try:
            await get_model()
        except Exception:  # noqa: BLE001
            log.exception(
                "startup: model load failed — service will start but "
                "transcribe endpoints will 503 until model is available"
            )

    yield

    # Graceful shutdown — drain pools so Postgres doesn't see stranded
    # connections across systemd restart cycles.
    log.info("shutdown: closing LLM client + DB engine…")
    try:
        await llm_close_client()
    except Exception:  # noqa: BLE001
        log.exception("llm client close failed")
    try:
        await db.dispose()
    except Exception:  # noqa: BLE001
        log.exception("db dispose failed")


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = FastAPI(
    title="Local Whisper Server",
    description="Phase 2 — Postgres-aware transcription + summarization worker.",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Catch-all exception handler
#
# Without this, an unhandled exception in a route can bubble out as an
# opaque 500 with no log line — making post-mortem painful when the
# server "just hangs". This handler:
#   1. Logs the full traceback (with route info)
#   2. Returns a structured JSON error so clients can surface it
#   3. NEVER lets the exception kill the worker
#
# HTTPException is handled separately so 4xx errors keep their semantics
# (no traceback log, no scary "internal error" wording).
# --------------------------------------------------------------------------

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception(
        "unhandled exception on %s %s: %s",
        request.method,
        request.url.path,
        exc,
    )
    return JSONResponse(
        status_code=500,
        content={
            "ok": False,
            "error": "internal_error",
            "detail": str(exc)[:300],
            "path": request.url.path,
        },
    )


# --------------------------------------------------------------------------
# Auth dep (optional)
# --------------------------------------------------------------------------

def _free_memory_mb() -> int:
    """
    Return free + buffers/cache MB as reported by /proc/meminfo. Returns
    a large number on systems without /proc (macOS dev) so the guard
    doesn't false-positive locally.
    """
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(":")
                    info[key] = int(parts[1])
        avail_kb = info.get("MemAvailable") or info.get("MemFree", 0)
        return avail_kb // 1024
    except Exception:  # noqa: BLE001
        return 999_999  # treat as unlimited if we can't read


def _check_memory_or_reject() -> None:
    """
    Raise 503 if free RAM is below the safety threshold. Cheaper than
    the kernel killing us mid-inference.
    """
    free_mb = _free_memory_mb()
    if free_mb < MIN_FREE_MEMORY_MB:
        log.warning(
            "rejecting task — only %s MB free (need >= %s MB)",
            free_mb,
            MIN_FREE_MEMORY_MB,
        )
        raise HTTPException(
            503,
            f"server low on memory ({free_mb} MB free, need {MIN_FREE_MEMORY_MB}). "
            "Try again in a moment.",
        )


def _free_disk_mb(path: str = "/tmp") -> int:
    """Bytes free at `path` mountpoint, divided to MB."""
    try:
        import shutil as _sh
        return _sh.disk_usage(path).free // (1024 * 1024)
    except Exception:  # noqa: BLE001
        return 999_999


MIN_FREE_DISK_MB = _env_int("WHISPER_MIN_FREE_DISK_MB", "1024")


def _check_disk_or_reject(needed_mb: int = 0) -> None:
    """
    Reject task if `/tmp` doesn't have enough room for the audio + scratch.
    Better to 503 fast than have `mkstemp` raise OSError half-way through
    a 200MB upload and leave a partial file behind.
    """
    free_mb = _free_disk_mb(tempfile.gettempdir())
    needed = max(needed_mb, MIN_FREE_DISK_MB)
    if free_mb < needed:
        log.warning(
            "rejecting task — only %s MB free on /tmp (need >= %s)",
            free_mb,
            needed,
        )
        raise HTTPException(
            507,
            f"server low on disk space ({free_mb} MB free, need {needed}).",
        )


def _validate_audio_file(path: str) -> tuple[float, str | None]:
    """
    Probe the audio file with ffprobe. Returns (duration_sec, error or None).
    Catches obviously corrupt uploads BEFORE handing them to Whisper —
    which would otherwise segfault or hallucinate on garbage bytes.
    """
    import subprocess
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            return 0.0, (r.stderr or "ffprobe failed").strip()[:200]
        out = (r.stdout or "0").strip()
        return float(out), None
    except FileNotFoundError:
        # ffprobe not installed — skip validation, hope Whisper handles it
        return 0.0, None
    except Exception as e:  # noqa: BLE001
        return 0.0, str(e)[:200]


async def require_api_key(
    authorization: Annotated[Optional[str], Header()] = None,
):
    if not API_KEY:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    if authorization.split(" ", 1)[1].strip() != API_KEY:
        raise HTTPException(401, "invalid api key")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/health")
async def health(deep: bool = False):
    """
    Cheap by default — returns config snapshot. With `?deep=true` also
    pings Postgres + the LLM endpoint so an operator (or uptime monitor)
    can distinguish "service is up but DB/LLM is broken" from "all good".
    Status code is always 200; clients inspect the booleans.
    """
    out = {
        "ok": True,
        "model": MODEL_SIZE,
        "compute_type": COMPUTE_TYPE,
        "device": DEVICE,
        "model_loaded": _model is not None,
        "max_concurrent": MAX_CONCURRENT,
    }
    if deep:
        db_ok = True
        try:
            await db.ping()
        except Exception:  # noqa: BLE001
            db_ok = False
        out["db_ok"] = db_ok
        out["llm_ok"] = await llm_healthcheck()
        out["ok"] = out["model_loaded"] and db_ok
    return out


def _tail_lines(path: str, n: int) -> list[str]:
    """
    Read last `n` lines of `path` without loading the whole file.
    Walks backward in 4 KB blocks until enough newlines are seen.
    Returns lines in chronological order (oldest first).
    """
    if not Path(path).exists():
        return []
    block = 4096
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        data = bytearray()
        # Stop when we have enough '\n' or reached the start of the file.
        while size > 0:
            read = min(block, size)
            size -= read
            f.seek(size)
            data = bytearray(f.read(read)) + data
            if data.count(b"\n") > n:
                break
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    return lines[-n:]


@app.get("/v1/logs")
def get_logs(
    lines: int = 200,
    _: None = Depends(require_api_key),
):
    """
    Tail the rotating app.log so operators can debug from the UI without
    SSH'ing into the box. Auth is the same shared-secret as the rest of
    the API (`WHISPER_SERVER_API_KEY`) — when blank, anyone on the
    network can read. In prod, set the key.
    """
    n = max(1, min(int(lines), 5000))
    path = os.getenv("APP_LOG_PATH", "app.log")
    out = _tail_lines(path, n)
    return {
        "path": path,
        "lines": out,
        "count": len(out),
    }


@app.get("/v1/models")
def list_models(_: None = Depends(require_api_key)):
    """OpenAI-compatible model listing (kept for client SDK compat)."""
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_SIZE,
                "object": "model",
                "created": 0,
                "owned_by": "faster-whisper",
            }
        ],
    }


# --------------------------------------------------------------------------
# Phase-2 task endpoint
# --------------------------------------------------------------------------

async def _run_whisper(audio_path: str, language: str | None) -> tuple[list[dict], dict]:
    """Run faster-whisper and return (segments, info)."""
    wmodel = await get_model()
    async with _inference_gate:
        log.info(
            "transcribing %s (%s bytes, lang=%s)",
            audio_path,
            Path(audio_path).stat().st_size,
            language or DEFAULT_LANGUAGE or "auto",
        )

        # VAD config (env-overridable). Defaults are slightly looser than
        # faster-whisper's built-ins so soft / low-SNR / non-English speech
        # doesn't get filtered out as "silence".
        #   threshold       — lower = catch quieter speech (0.5 = strict)
        #   min_speech_ms   — drop blips shorter than this (default 250)
        #   min_silence_ms  — gap that ends a segment (default 100)
        vad_enabled = (
            os.getenv("WHISPER_VAD_FILTER", "true").split("#")[0].strip().lower()
            in ("1", "true", "yes")
        )

        def _env_float(name: str, default: str) -> float:
            raw = (os.getenv(name) or default).split("#", 1)[0].strip()
            try:
                return float(raw)
            except ValueError:
                return float(default)

        vad_params = {
            "threshold": _env_float("WHISPER_VAD_THRESHOLD", "0.35"),
            "min_speech_duration_ms": _env_int("WHISPER_VAD_MIN_SPEECH_MS", "200"),
            "min_silence_duration_ms": _env_int("WHISPER_VAD_MIN_SILENCE_MS", "300"),
        }

        def _do_transcribe(use_vad: bool):
            """Run a single transcribe attempt; raise on failure."""
            kwargs = {
                "language": language or DEFAULT_LANGUAGE,
                "beam_size": DEFAULT_BEAM_SIZE,
                # Temperature fallback ladder. When the decoder hits a
                # low-confidence or repetitive output (compression_ratio
                # too high or avg_logprob too low), faster-whisper retries
                # with the next temperature. Without a ladder we'd be
                # stuck on greedy decoding and prone to repetition loops
                # on silence / music / mumble.
                "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                # If the model output compresses to < 1/2.4 of its size
                # (i.e. very repetitive), reject + retry with higher temp.
                "compression_ratio_threshold": 2.4,
                # Reject segments below this average log-probability —
                # cheaper than letting hallucinations through.
                "log_prob_threshold": -1.0,
                # Drop segments tagged as "no speech" with > 60% confidence.
                "no_speech_threshold": 0.6,
                # CRITICAL for stopping repetition cascades — when True
                # (the library default), each new segment is decoded with
                # the previous segment as a hint. If the model ever
                # produces a hallucinated line, it gets fed back in and
                # the loop locks in. False breaks the chain.
                "condition_on_previous_text": False,
            }
            if use_vad:
                kwargs["vad_filter"] = True
                kwargs["vad_parameters"] = vad_params
            # Batched pipeline: ~3-5x faster on long clips because it
            # parallelises 30s chunks. Slight quality regression for very
            # short clips and across-chunk context (no condition_on_previous).
            if USE_BATCHED and _batched is not None:
                kwargs["batch_size"] = BATCH_SIZE
                segments_iter, info = _batched.transcribe(audio_path, **kwargs)
            else:
                segments_iter, info = wmodel.transcribe(audio_path, **kwargs)
            return list(segments_iter), info

        def _run():
            # faster-whisper raises "max() iterable argument is empty" in
            # two distinct places:
            #   1. inside transcribe() itself — during auto language detection
            #      when the audio has zero detectable speech frames
            #   2. inside the segment generator — when VAD finds zero speech
            #      regions to transcribe
            # If the first pass (VAD on) returns nothing or raises this
            # error, retry once with VAD off — quiet/noisy clips often
            # transcribe fine without VAD's filtering step.
            from types import SimpleNamespace
            empty_info = SimpleNamespace(
                language=language or DEFAULT_LANGUAGE or "unknown",
                duration=0.0,
            )
            try:
                segments, info = _do_transcribe(use_vad=vad_enabled)
            except ValueError as e:
                if "max() iterable argument is empty" not in str(e):
                    raise
                log.warning(
                    "VAD pass failed for %s — retrying without VAD (%s)",
                    audio_path,
                    e,
                )
                try:
                    segments, info = _do_transcribe(use_vad=False)
                except ValueError as e2:
                    if "max() iterable argument is empty" in str(e2):
                        log.warning(
                            "no speech detected in %s after fallback — empty transcript",
                            audio_path,
                        )
                        return [], empty_info
                    raise

            # Fallback: VAD ran without raising but produced zero segments
            # while audio is clearly non-empty. Retry without VAD.
            if vad_enabled and not segments and Path(audio_path).stat().st_size > 10_000:
                log.warning(
                    "VAD produced 0 segments for %s — retrying without VAD",
                    audio_path,
                )
                try:
                    segments, info = _do_transcribe(use_vad=False)
                except ValueError as e:
                    if "max() iterable argument is empty" in str(e):
                        return [], empty_info
                    raise

            return segments, info

        # Wall-clock inference timeout — if the decoder gets wedged on a
        # bad clip (segfault loop, infinite repetition lock, etc.) we'd
        # never recover without external SIGTERM. Cap it: if `_run`
        # doesn't return in N minutes, raise TimeoutError so the worker
        # marks FAILED and frees the inference gate.
        infer_timeout = _env_int("WHISPER_INFERENCE_TIMEOUT_SEC", "1800")
        try:
            segments, info = await asyncio.wait_for(
                asyncio.to_thread(_run),
                timeout=infer_timeout,
            )
        except asyncio.TimeoutError:
            log.error(
                "transcribe stuck > %ds on %s — failing the task",
                infer_timeout,
                audio_path,
            )
            raise RuntimeError(
                f"inference timed out after {infer_timeout}s — "
                "audio may be corrupt or model wedged"
            )
    out = []
    for seg in segments:
        out.append(
            {
                "startSec": round(float(seg.start), 2),
                "endSec": round(float(seg.end), 2),
                "text": (seg.text or "").strip(),
            }
        )
    return out, {
        "language": info.language,
        "duration": float(info.duration),
    }


async def _process_task(task_id: str, tmp_path: str, language: str | None) -> None:
    """
    BackgroundTask body. Owns the full Python-side pipeline:
      verify task → TRANSCRIBING → save transcript → SUMMARIZING →
      save summary + chapters → COMPLETED. On failure: FAILED + log.
    """
    try:
        recording_id = await get_recording_id(task_id)
        if not recording_id:
            log.error("task %s has no recordingId — aborting", task_id)
            await mark_failed(task_id, "task missing recordingId")
            return

        # ── TRANSCRIBE ──────────────────────────────────────────────
        await set_status(task_id, TaskStatus.TRANSCRIBING)
        await append_log(task_id, "info", "transcribe", "received audio")
        try:
            segments, info = await _run_whisper(tmp_path, language)
        except Exception as e:  # noqa: BLE001
            log.exception("whisper failed")
            await append_log(task_id, "error", "transcribe", str(e))
            await mark_failed(task_id, f"whisper: {e}")
            return

        if segments:
            # Sanity-check segments before persisting — guards against
            # decoder bugs that emit garbage timestamps or text with
            # control chars / zero-width junk. Drop ones that fail; if
            # everything fails, treat as empty transcript.
            cleaned = []
            for s in segments:
                try:
                    start = float(s.get("startSec", 0))
                    end = float(s.get("endSec", 0))
                    text = (s.get("text") or "").strip()
                    if (
                        not text
                        or end < start
                        or start < 0
                        or end - start > 600   # 10 min single segment = decoder bug
                    ):
                        continue
                    # strip control chars (Whisper sometimes emits 0xFFFD)
                    text = "".join(c for c in text if c.isprintable() or c.isspace())
                    if not text:
                        continue
                    cleaned.append({"startSec": start, "endSec": end, "text": text})
                except Exception:  # noqa: BLE001
                    continue
            dropped = len(segments) - len(cleaned)
            if dropped > 0:
                log.warning(
                    "dropped %d malformed segments from task %s output",
                    dropped,
                    task_id,
                )
            if cleaned:
                await save_transcript(recording_id, cleaned)
                await append_log(
                    task_id,
                    "info",
                    "transcribe",
                    f"{len(cleaned)} segments (dropped {dropped}), lang={info.get('language')}",
                )
                segments = cleaned
            else:
                await append_log(
                    task_id, "warn", "transcribe", "all segments dropped after validation"
                )
                await mark_completed(task_id)
                return
        else:
            await append_log(
                task_id, "warn", "transcribe", "no segments produced"
            )
            # Still mark completed — the video itself is fine, just no transcript.
            await mark_completed(task_id)
            return

        # ── SUMMARIZE + auto-chapters ───────────────────────────────
        await set_status(task_id, TaskStatus.SUMMARIZING)
        await append_log(task_id, "info", "summarize", "calling LLM")
        flat = " ".join(s["text"] for s in segments)

        async def _summary_task() -> None:
            try:
                s = await summarize(flat)
                if s:
                    await save_auto_summary(recording_id, s)
                    await append_log(
                        task_id, "info", "summarize", f"{len(s)} chars"
                    )
                else:
                    await append_log(
                        task_id, "warn", "summarize", "LLM not configured or empty reply"
                    )
            except Exception as e:  # noqa: BLE001
                log.exception("summarize failed")
                await append_log(task_id, "error", "summarize", str(e))

        async def _chapters_task() -> None:
            try:
                ch = await generate_chapters(segments)
                if ch:
                    await save_auto_chapters(recording_id, ch)
                    await append_log(
                        task_id,
                        "info",
                        "auto-chapters",
                        f"{len(ch)} chapters",
                    )
            except Exception as e:  # noqa: BLE001
                log.exception("auto-chapters failed")
                await append_log(task_id, "error", "auto-chapters", str(e))

        await asyncio.gather(_summary_task(), _chapters_task())

        # ── COMPLETED ───────────────────────────────────────────────
        await mark_completed(task_id)
        await append_log(task_id, "info", "done", "task completed")
        log.info("task %s completed", task_id)
    except Exception as e:  # noqa: BLE001
        # Catch-all: never let a background task die silently.
        tb = traceback.format_exc()
        log.error("task %s failed: %s\n%s", task_id, e, tb)
        try:
            await append_log(task_id, "error", "fatal", str(e))
            await mark_failed(task_id, str(e))
        except Exception:  # noqa: BLE001
            log.exception("could not record failure on task %s", task_id)
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            log.warning("could not remove temp file %s", tmp_path)


@app.post("/v1/tasks", status_code=202)
async def enqueue_task(
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File(description="Audio file (mp3 preferred).")],
    task_id: Annotated[str, Form()],
    language: Annotated[Optional[str], Form()] = None,
    _: None = Depends(require_api_key),
):
    """
    Push-mode handoff (fallback). Node uploads the mp3 in the request body
    and we drive the rest. Used when:
      - the operator clicks "Manual retry" on the admin tasks UI, or
      - S3 is unreachable and pull-mode failed

    Pull-mode (`POST /v1/tasks/from-s3`) is the default; this endpoint
    stays for the manual escape hatch.
    """
    if file.size and file.size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file too large (>{MAX_UPLOAD_MB} MB)")

    _check_memory_or_reject()
    # Need at least room for the upload + a bit of scratch
    _check_disk_or_reject(
        needed_mb=((file.size or 0) // (1024 * 1024)) + MIN_FREE_DISK_MB,
    )

    # Verify the task exists before accepting work — saves us from
    # processing audio that won't have anywhere to write its results.
    if not await task_exists(task_id):
        raise HTTPException(404, f"task {task_id} not found")

    suffix = Path(file.filename or "audio").suffix or ".mp3"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix=f"olp-{task_id}-")
    with os.fdopen(fd, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)

    # Validate the upload actually contains audio before queueing — saves
    # the worker from segfaulting on a corrupt mp3.
    duration, ferr = _validate_audio_file(tmp_path)
    if ferr is not None:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(400, f"audio probe failed: {ferr}")

    log.info(
        "accepted task %s via PUSH (%s bytes, %.1fs, lang=%s)",
        task_id,
        Path(tmp_path).stat().st_size,
        duration,
        language or "auto",
    )
    background_tasks.add_task(_process_task, task_id, tmp_path, language)
    return {"ok": True, "task_id": task_id, "transport": "push"}


class PullTaskBody(BaseModel):
    task_id: str
    key: str
    bucket: Optional[str] = None
    language: Optional[str] = None


@app.post("/v1/tasks/from-s3", status_code=202)
async def enqueue_task_from_s3(
    body: PullTaskBody,
    background_tasks: BackgroundTasks,
    _: None = Depends(require_api_key),
):
    """
    Pull-mode handoff (default). Node sends just task_id + S3 key; we
    fetch the mp3 from MinIO ourselves. Cheap JSON payload, zero file
    bytes over the wire from Node — survives long clips + Node restarts.
    """
    _check_memory_or_reject()
    _check_disk_or_reject()

    if not await task_exists(body.task_id):
        raise HTTPException(404, f"task {body.task_id} not found")

    bucket = body.bucket or s3_default_bucket()
    if not bucket:
        raise HTTPException(
            400, "no bucket — set S3_BUCKET env or include 'bucket' in the body"
        )

    # Pre-flight size check — cheap HEAD round-trip, avoids downloading
    # gigabyte-sized objects only to reject them after.
    try:
        size = await s3_head_size(bucket, body.key)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"s3 head failed for {body.key}: {e}") from e
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"object too large (>{MAX_UPLOAD_MB} MB)")

    suffix = Path(body.key).suffix or ".mp3"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix=f"olp-{body.task_id}-")
    os.close(fd)
    try:
        await s3_download_to_file(bucket, body.key, tmp_path)
    except Exception as e:
        # Clean up the empty tmp before bubbling — caller decides whether
        # to fall back to push mode (manual retry).
        Path(tmp_path).unlink(missing_ok=True)
        log.exception("s3 download failed for task %s", body.task_id)
        raise HTTPException(502, f"s3 download failed: {e}") from e

    # Validate downloaded audio before scheduling — corrupt S3 object
    # otherwise crashes the worker mid-decode.
    duration, ferr = _validate_audio_file(tmp_path)
    if ferr is not None:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(400, f"audio probe failed: {ferr}")

    log.info(
        "accepted task %s via PULL s3://%s/%s (%s bytes, %.1fs, lang=%s)",
        body.task_id,
        bucket,
        body.key,
        size,
        duration,
        body.language or "auto",
    )
    background_tasks.add_task(_process_task, body.task_id, tmp_path, body.language)
    return {"ok": True, "task_id": body.task_id, "transport": "pull"}


# --------------------------------------------------------------------------
# Legacy synchronous endpoint — kept for compatibility (Node Phase 1 used
# this). Not removed yet; flag with a header so callers know to migrate.
# --------------------------------------------------------------------------

@app.post("/v1/audio/transcriptions", deprecated=True)
async def transcribe_sync(
    file: Annotated[UploadFile, File()],
    model: Annotated[Optional[str], Form()] = None,  # noqa: ARG001 — accepted for compat
    language: Annotated[Optional[str], Form()] = None,
    response_format: Annotated[str, Form()] = "verbose_json",
    temperature: Annotated[float, Form()] = 0.0,  # noqa: ARG001 — fixed in this impl
    timestamp_granularities: Annotated[Optional[list[str]], Form()] = None,  # noqa: ARG001
    prompt: Annotated[Optional[str], Form()] = None,  # noqa: ARG001
    _: None = Depends(require_api_key),
):
    """
    OpenAI-compatible synchronous transcription. Phase 2 prefers
    /v1/tasks; this stays for ad-hoc tooling.
    """
    if file.size and file.size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file too large (>{MAX_UPLOAD_MB} MB)")

    suffix = Path(file.filename or "audio").suffix or ".mp3"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
        segments, info = await _run_whisper(tmp_path, language)
        full_text = " ".join(s["text"] for s in segments).strip()
        if response_format == "text":
            return PlainTextResponse(full_text)
        if response_format == "json":
            return {"text": full_text}
        return {
            "task": "transcribe",
            "language": info["language"],
            "duration": info["duration"],
            "text": full_text,
            "segments": [
                {
                    "id": i,
                    "start": s["startSec"],
                    "end": s["endSec"],
                    "text": s["text"],
                }
                for i, s in enumerate(segments)
            ],
        }
    finally:
        Path(tmp_path).unlink(missing_ok=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=_env_int("PORT", "8000"),
        workers=_env_int("UVICORN_WORKERS", "1"),
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
