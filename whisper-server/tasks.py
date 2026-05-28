"""
Task / SessionRecording write helpers — Python's slice of the Postgres
schema that Prisma owns.

Only the columns Python touches are referenced. Schema source-of-truth
is `backend/prisma/schema.prisma`.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from db import session_scope, with_retry

log = logging.getLogger("whisper-server.tasks")

# Mirror of the TaskStatus enum in Prisma. Values are Postgres enum
# labels (case-sensitive).
class TaskStatus:
    PENDING = "PENDING"
    CLAIMED = "CLAIMED"
    TRANSCODING = "TRANSCODING"
    EXTRACTING_AUDIO = "EXTRACTING_AUDIO"
    UPLOADING_AUDIO = "UPLOADING_AUDIO"
    THUMBNAIL = "THUMBNAIL"
    HANDED_OFF = "HANDED_OFF"
    TRANSCRIBING = "TRANSCRIBING"
    SUMMARIZING = "SUMMARIZING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


MAX_LOG_ENTRIES = 200


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_log(level: str, stage: str, message: str) -> dict[str, str]:
    return {
        "ts": _now_iso(),
        "level": level,
        "stage": stage,
        "message": message[:500],
    }


async def task_exists(task_id: str) -> bool:
    async with session_scope() as s:
        row = await s.execute(
            text('SELECT 1 FROM "Task" WHERE id = :id'), {"id": task_id}
        )
        return row.first() is not None


async def get_recording_id(task_id: str) -> str | None:
    async with session_scope() as s:
        row = await s.execute(
            text('SELECT "recordingId" FROM "Task" WHERE id = :id'),
            {"id": task_id},
        )
        r = row.first()
        return r[0] if r else None


async def set_status(task_id: str, status: str) -> None:
    # NOTE: use CAST(... AS type) instead of `:param::type`. SQLAlchemy's
    # named-parameter parser refuses to bind `:name` when followed by
    # `::` (postgres cast operator) — it leaves the literal `:name` in
    # the SQL, which asyncpg then rejects as a syntax error.
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "Task" SET status = CAST(:status AS "TaskStatus"), '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"status": status, "id": task_id},
            )

    await with_retry(_do, op_name=f"set_status({task_id}, {status})")


async def append_log(
    task_id: str, level: str, stage: str, message: str
) -> None:
    """
    Read-modify-write append capped at MAX_LOG_ENTRIES. Single-writer at
    this stage (only Python has the row), so no atomicity concern.
    """
    entry = _make_log(level, stage, message)
    async with session_scope() as s:
        row = await s.execute(
            text('SELECT logs FROM "Task" WHERE id = :id'), {"id": task_id}
        )
        r = row.first()
        existing: list[Any] = list(r[0] or []) if r else []
        merged = existing + [entry]
        if len(merged) > MAX_LOG_ENTRIES:
            merged = merged[-MAX_LOG_ENTRIES:]
        await s.execute(
            text(
                'UPDATE "Task" SET logs = CAST(:logs AS jsonb), '
                '"updatedAt" = now() WHERE id = :id'
            ),
            {"logs": json.dumps(merged), "id": task_id},
        )


async def mark_completed(task_id: str) -> None:
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "Task" SET status = CAST(\'COMPLETED\' AS "TaskStatus"), '
                    '"completedAt" = now(), "errorMessage" = NULL, '
                    '"lockedBy" = NULL, "lockedUntil" = NULL, '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"id": task_id},
            )

    await with_retry(_do, op_name=f"mark_completed({task_id})")


async def mark_failed(task_id: str, error_message: str) -> None:
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "Task" SET status = CAST(\'FAILED\' AS "TaskStatus"), '
                    '"completedAt" = now(), "errorMessage" = :err, '
                    '"lockedBy" = NULL, "lockedUntil" = NULL, '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"err": error_message[:500], "id": task_id},
            )

    await with_retry(_do, op_name=f"mark_failed({task_id})")


async def save_transcript(
    recording_id: str, segments: list[dict[str, Any]]
) -> None:
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "SessionRecording" SET transcript = CAST(:seg AS jsonb), '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"seg": json.dumps(segments), "id": recording_id},
            )

    await with_retry(_do, op_name=f"save_transcript({recording_id})")


async def save_auto_summary(recording_id: str, summary: str) -> None:
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "SessionRecording" SET "autoSummary" = :sum, '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"sum": summary[:2000], "id": recording_id},
            )

    await with_retry(_do, op_name=f"save_auto_summary({recording_id})")


async def save_auto_chapters(
    recording_id: str, chapters: list[dict[str, Any]]
) -> None:
    async def _do():
        async with session_scope() as s:
            await s.execute(
                text(
                    'UPDATE "SessionRecording" SET "autoChapters" = CAST(:ch AS jsonb), '
                    '"updatedAt" = now() WHERE id = :id'
                ),
                {"ch": json.dumps(chapters), "id": recording_id},
            )

    await with_retry(_do, op_name=f"save_auto_chapters({recording_id})")


# Statuses that indicate Python is actively processing — if a row is in
# any of these but the process owning it died, the row will sit there
# forever because Node's worker doesn't touch HANDED_OFF+ statuses.
_PYTHON_OWNED_STATUSES = ("HANDED_OFF", "TRANSCRIBING", "SUMMARIZING")


async def sweep_stuck_tasks(max_age_minutes: int = 30) -> int:
    """
    Boot-time recovery: any Task left in a Python-owned status for longer
    than `max_age_minutes` is assumed orphaned (the previous process died
    mid-task) and gets marked FAILED so the operator can retry from the
    admin UI. Returns the count swept.

    Threshold is generous (30 min default) because real long-form
    transcription can legitimately take 10–20 minutes for a 90-min lecture.
    """
    async with session_scope() as s:
        result = await s.execute(
            text(
                'UPDATE "Task" SET '
                '  status = CAST(\'FAILED\' AS "TaskStatus"), '
                '  "errorMessage" = :msg, '
                '  "completedAt" = now(), '
                '  "lockedBy" = NULL, '
                '  "lockedUntil" = NULL, '
                '  "updatedAt" = now() '
                'WHERE status::text = ANY(:statuses) '
                '  AND "updatedAt" < (now() - (:age || \' minutes\')::interval) '
                'RETURNING id'
            ),
            {
                "msg": (
                    f"orphaned — process died while holding this task "
                    f"(stuck > {max_age_minutes} min); retry from admin UI"
                ),
                "statuses": list(_PYTHON_OWNED_STATUSES),
                "age": str(max_age_minutes),
            },
        )
        rows = result.fetchall()
        count = len(rows)
        if count > 0:
            log.warning(
                "swept %d stuck tasks (statuses=%s, age>%dm): %s",
                count,
                _PYTHON_OWNED_STATUSES,
                max_age_minutes,
                [r[0] for r in rows],
            )
        return count
