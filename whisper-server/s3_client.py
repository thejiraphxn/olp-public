"""
Minimal S3 client used by the pull-mode handoff (`POST /v1/tasks/from-s3`).

Reads endpoint + credentials from env. boto3 is sync, so download_to_file
runs in a thread to avoid blocking the FastAPI event loop.
"""
import asyncio
import logging
import os
from typing import Optional

import boto3
from botocore.client import Config

log = logging.getLogger(__name__)


def _build_client():
    endpoint = os.getenv("S3_ENDPOINT") or None
    region = os.getenv("S3_REGION") or "us-east-1"
    access_key = os.getenv("S3_ACCESS_KEY") or None
    secret_key = os.getenv("S3_SECRET_KEY") or None
    force_path_style = (
        os.getenv("S3_FORCE_PATH_STYLE", "true").lower() in ("1", "true", "yes")
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if force_path_style else "auto"},
            connect_timeout=10,
            read_timeout=120,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


_client: Optional["boto3.client"] = None


def get_client():
    """Lazy singleton — fail loudly if env is missing instead of at import time."""
    global _client
    if _client is None:
        _client = _build_client()
    return _client


def default_bucket() -> Optional[str]:
    return os.getenv("S3_BUCKET") or None


async def head_size(bucket: str, key: str) -> int:
    """Return ContentLength for an S3 key. Cheap (no body transfer)."""
    def _do() -> int:
        client = get_client()
        return int(client.head_object(Bucket=bucket, Key=key)["ContentLength"])

    return await asyncio.to_thread(_do)


async def download_to_file(bucket: str, key: str, dest_path: str) -> int:
    """
    Download S3 object to `dest_path`. Returns the size in bytes. Raises
    on missing object / auth failure — caller decides how to surface.
    """
    def _do():
        client = get_client()
        client.download_file(bucket, key, dest_path)
        return os.path.getsize(dest_path)

    log.info("s3 download s3://%s/%s -> %s", bucket, key, dest_path)
    size = await asyncio.to_thread(_do)
    log.info("s3 download done (%s bytes)", size)
    return size
