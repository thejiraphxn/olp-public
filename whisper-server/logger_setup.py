"""
Rotating file logger + console handler.

Used by both the FastAPI server and the BackgroundTask flow. Every state
transition we record on the Task row also lands here, so an operator can
read app.log to diagnose without going to Postgres.
"""
import logging
import os
from logging.handlers import RotatingFileHandler


def setup_logging() -> logging.Logger:
    level_name = os.getenv("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )

    root = logging.getLogger()
    root.setLevel(level)

    # Don't double-attach handlers if setup_logging is called twice (uvicorn
    # reload can do that).
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        path = os.getenv("APP_LOG_PATH", "app.log")
        max_bytes = int(os.getenv("APP_LOG_MAX_BYTES", str(10 * 1024 * 1024)))
        backups = int(os.getenv("APP_LOG_BACKUP_COUNT", "5"))
        fh = RotatingFileHandler(path, maxBytes=max_bytes, backupCount=backups)
        fh.setFormatter(fmt)
        fh.setLevel(level)
        root.addHandler(fh)

    if not any(isinstance(h, logging.StreamHandler) and not isinstance(h, RotatingFileHandler) for h in root.handlers):
        ch = logging.StreamHandler()
        ch.setFormatter(fmt)
        ch.setLevel(level)
        root.addHandler(ch)

    return logging.getLogger("whisper-server")
