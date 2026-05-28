"""
LLM client — speaks /v1/chat/completions which works for Groq, Ollama
Cloud, Anthropic OpenAI-compat, etc. Returns None when the LLM isn't
configured so the caller can skip silently.
"""
import asyncio
import json
import logging
import os
import re
from typing import Any, Optional

import httpx

log = logging.getLogger("whisper-server.llm")

# Retry policy for transient LLM failures (429 rate-limit, 5xx, network
# timeouts). Schema problems (400) re-raise immediately.
LLM_RETRY_ATTEMPTS = int(os.getenv("LLM_RETRY_ATTEMPTS", "3"))
LLM_RETRY_BASE_DELAY = float(os.getenv("LLM_RETRY_BASE_DELAY", "1.0"))

# Module-level singleton client. httpx pools connections per client, so
# reusing one across calls saves the cost of TLS handshake + DNS per
# request and prevents FD exhaustion when many tasks fan out.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        timeout = float(os.getenv("LLM_TIMEOUT_SECONDS", "60"))
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )
    return _client


async def close_client() -> None:
    """Wire to FastAPI lifespan exit so we drain keep-alive connections."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def healthcheck() -> bool:
    """
    Cheap probe for /health — verifies the LLM endpoint is reachable
    without spending tokens. GETs the base URL (most providers reply
    200/404 within a few hundred ms). Returns False on any error.
    """
    cfg = _llm_config()
    if not cfg:
        return False
    try:
        client = _get_client()
        r = await client.get(cfg["url"], timeout=5.0)
        return r.status_code < 500
    except Exception:  # noqa: BLE001
        return False


def _llm_config() -> dict[str, str] | None:
    url = (os.getenv("LLM_API_URL") or "").strip().rstrip("/")
    if not url:
        return None
    if not re.search(r"/v\d+$", url):
        url = f"{url}/v1"
    return {
        "url": url,
        "key": (os.getenv("LLM_API_KEY") or "").strip(),
        "model": (os.getenv("LLM_MODEL") or "llama-3.3-70b-versatile").strip(),
    }


def _truncate(text: str, max_chars: int = 16_000) -> str:
    if len(text) <= max_chars:
        return text
    head = text[: int(max_chars * 0.6)]
    tail = text[-int(max_chars * 0.4) :]
    return (
        f"{head}\n\n[...truncated middle "
        f"{len(text) - max_chars} chars...]\n\n{tail}"
    )


def _fmt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{sec:02d}"
    return f"{m:02d}:{sec:02d}"


async def _chat(
    cfg: dict[str, str],
    messages: list[dict[str, str]],
    json_mode: bool = False,
) -> str | None:
    body: dict[str, Any] = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0.2,
        "stream": False,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"

    log.info(
        "LLM call → url=%s model=%s json_mode=%s",
        cfg["url"],
        cfg["model"],
        json_mode,
    )
    client = _get_client()
    # Retry on 429 (rate limit) and 5xx (provider overload) with
    # exponential backoff. Transport failures (timeout, conn reset) also
    # retried. 4xx other than 429 re-raise immediately — they don't get
    # better by retrying (wrong key, wrong model, malformed body).
    timeout = float(os.getenv("LLM_TIMEOUT_SECONDS", "60"))
    last_err: Exception | None = None
    r = None
    for attempt in range(LLM_RETRY_ATTEMPTS):
        try:
            r = await client.post(
                f"{cfg['url']}/chat/completions",
                headers=headers,
                json=body,
            )
        except httpx.TimeoutException as e:
            last_err = RuntimeError(f"LLM timed out after {timeout}s")
            log.warning(
                "LLM timeout (attempt %d/%d): %s",
                attempt + 1,
                LLM_RETRY_ATTEMPTS,
                e,
            )
        except httpx.HTTPError as e:
            last_err = RuntimeError(f"LLM transport error: {e}")
            log.warning(
                "LLM transport error (attempt %d/%d): %s",
                attempt + 1,
                LLM_RETRY_ATTEMPTS,
                e,
            )
        else:
            # Got a response — decide retry vs fail vs accept
            if r.status_code == 404:
                raise RuntimeError(
                    f"LLM 404 — check LLM_API_URL ({cfg['url']}) and LLM_MODEL "
                    f"({cfg['model']}). Body: {r.text[:200]}"
                )
            if r.status_code == 429 or r.status_code >= 500:
                last_err = RuntimeError(
                    f"LLM {r.status_code}: {r.text[:200]}"
                )
                log.warning(
                    "LLM transient %d (attempt %d/%d): %s",
                    r.status_code,
                    attempt + 1,
                    LLM_RETRY_ATTEMPTS,
                    r.text[:200],
                )
            elif r.status_code >= 400:
                # Non-retriable client error
                raise RuntimeError(f"LLM {r.status_code}: {r.text[:300]}")
            else:
                last_err = None
                break

        # backoff before next attempt (skip on last)
        if attempt < LLM_RETRY_ATTEMPTS - 1:
            delay = LLM_RETRY_BASE_DELAY * (2 ** attempt)
            await asyncio.sleep(delay)

    if last_err is not None or r is None:
        raise last_err or RuntimeError("LLM call failed with no response")
    data = r.json()
    return (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip() or None


async def summarize(transcript_text: str) -> str | None:
    cfg = _llm_config()
    if not cfg:
        return None
    reply = await _chat(
        cfg,
        [
            {
                "role": "system",
                "content": (
                    "You summarize lecture transcripts in 2 to 3 sentences. "
                    "Plain text, no markdown, no bullet points. Keep it factual "
                    "and match the transcript language."
                ),
            },
            {
                "role": "user",
                "content": f"Summarize this lecture:\n\n{_truncate(transcript_text)}",
            },
        ],
    )
    return reply[:800] if reply else None


async def generate_chapters(
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    cfg = _llm_config()
    if not cfg:
        return None
    if len(segments) < 6:
        return []

    lines = "\n".join(
        f"[{_fmt_time(float(s.get('startSec', 0)))}] {s.get('text', '')}"
        for s in segments
    )
    prompt = (
        "You are annotating a lecture transcript. Propose 3–8 chapters.\n"
        "Respond with a JSON object of shape:\n"
        "  { \"chapters\": [ { \"timeSec\": number, \"label\": \"short title\" } ] }\n"
        "Use the timestamps shown in [HH:MM:SS] brackets as the timeSec.\n"
        "Labels must be 3–7 words, descriptive, and in the same language as the transcript.\n"
        "\nTRANSCRIPT:\n"
        f"{_truncate(lines)}"
    )
    reply = await _chat(
        cfg,
        [
            {
                "role": "system",
                "content": "You output only valid JSON. No prose before or after the JSON object.",
            },
            {"role": "user", "content": prompt},
        ],
        json_mode=True,
    )
    if not reply:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*", "", reply, flags=re.I)
    cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        # Surface the bad payload in logs so the operator can spot
        # consistently-broken provider replies (e.g. wrong model name
        # producing chatty markdown instead of pure JSON).
        log.warning(
            "LLM returned invalid JSON for auto-chapters: %s · payload[:200]=%r",
            e,
            cleaned[:200],
        )
        return None
    arr: list[dict[str, Any]]
    if isinstance(parsed, list):
        arr = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("chapters"), list):
        arr = parsed["chapters"]
    else:
        arr = []
    cleaned_arr: list[dict[str, Any]] = []
    for c in arr:
        if not isinstance(c, dict):
            continue
        if not isinstance(c.get("timeSec"), (int, float)):
            continue
        if not isinstance(c.get("label"), str):
            continue
        cleaned_arr.append(
            {
                "timeSec": max(0, round(float(c["timeSec"]))),
                "label": c["label"][:120],
            }
        )
    cleaned_arr.sort(key=lambda x: x["timeSec"])
    return cleaned_arr[:12]
