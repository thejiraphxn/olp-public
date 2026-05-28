"""
Async SQLAlchemy engine + session factory.

Prisma owns the schema; this module just connects with the same URL.
Use `+asyncpg` in the DATABASE_URL so SQLAlchemy picks the right driver.
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable, TypeVar

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

log = logging.getLogger("whisper-server.db")
T = TypeVar("T")


def _normalize_url(raw: str) -> str:
    """
    Tolerate two URL flavors:
      postgresql://...           ← Prisma form (used by Node)
      postgresql+asyncpg://...   ← SQLAlchemy form (what asyncpg needs)
    Add the +asyncpg if missing so operators can paste either.
    """
    if raw.startswith("postgresql://"):
        return raw.replace("postgresql://", "postgresql+asyncpg://", 1)
    if raw.startswith("postgres://"):
        return raw.replace("postgres://", "postgresql+asyncpg://", 1)
    return raw


_engine = None
_SessionFactory: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine, _SessionFactory
    if _engine is None:
        url = os.getenv("DATABASE_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL is not set — Phase 2 needs Postgres access"
            )
        # Pool sizing — must be at least MAX_CONCURRENT × 2 because a single
        # task can hold two connections at once (transcript save + summary
        # save run via asyncio.gather). Default 8 leaves headroom for the
        # boot-time stuck-task sweep + /health probes.
        pool_size = int(os.getenv("DB_POOL_SIZE", "8"))
        max_overflow = int(os.getenv("DB_MAX_OVERFLOW", "4"))
        _engine = create_async_engine(
            _normalize_url(url),
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,  # bounce idle connections every 30 min
        )
        _SessionFactory = async_sessionmaker(
            _engine, expire_on_commit=False, class_=AsyncSession
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _SessionFactory is not None
    return _SessionFactory


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def ping() -> None:
    """
    Run `SELECT 1` to verify the engine can actually reach Postgres.
    Called at startup so a misconfigured DATABASE_URL fails the service
    boot instead of silently breaking every task later.
    """
    async with session_scope() as s:
        await s.execute(text("SELECT 1"))


async def dispose() -> None:
    """Close the engine + drain the pool. Wire to FastAPI lifespan exit."""
    global _engine, _SessionFactory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _SessionFactory = None


async def with_retry(
    op: Callable[[], Awaitable[T]],
    *,
    attempts: int = 4,
    base_delay: float = 0.5,
    op_name: str = "db op",
) -> T:
    """
    Retry a DB op on transient errors (Postgres restart, dropped
    connection, server-side timeout). Exponential backoff capped at 4s.

    Catches `OperationalError` and `DBAPIError` with connection_invalidated
    — these are the failure modes that survive a Postgres restart. Other
    errors (constraint violation, syntax) re-raise immediately.
    """
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            return await op()
        except (OperationalError, DBAPIError) as e:
            last_err = e
            # Only retry connection-flavoured errors. Real schema problems
            # don't get better by retrying.
            connection_lost = (
                isinstance(e, OperationalError)
                or getattr(e, "connection_invalidated", False)
                or "server closed the connection" in str(e).lower()
                or "connection refused" in str(e).lower()
            )
            if not connection_lost:
                raise
            if i == attempts - 1:
                log.error(
                    "%s failed after %d attempts: %s", op_name, attempts, e
                )
                raise
            delay = min(base_delay * (2 ** i), 4.0)
            log.warning(
                "%s transient failure (attempt %d/%d) — retrying in %.1fs: %s",
                op_name,
                i + 1,
                attempts,
                delay,
                e,
            )
            await asyncio.sleep(delay)
    assert last_err is not None
    raise last_err
