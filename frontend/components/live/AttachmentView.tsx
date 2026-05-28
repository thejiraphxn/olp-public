'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ChatAttachment } from '@/lib/live-types';

/**
 * Renders a chat attachment with a short-lived presigned URL.
 *   - image/*  → clickable thumbnail (opens full size in a new tab)
 *   - audio/*  → inline <audio controls> + download link
 *   - video/*  → inline <video controls> + download link
 *   - else     → download chip (📎 name · size)
 *
 * Used by both the live chat panel and the playback-page chat-history tab,
 * so the same drag-and-drop / click-and-paste media replays the same way.
 */
export function AttachmentView({
  attachment,
  courseId,
  sessionId,
}: {
  attachment: ChatAttachment;
  courseId: string;
  sessionId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api<{ url: string }>(
      `/courses/${courseId}/sessions/${sessionId}/uploads/sign?key=${encodeURIComponent(
        attachment.key,
      )}`,
    )
      .then((r) => setUrl(r.url))
      .catch(() => {});
  }, [attachment.key, courseId, sessionId]);

  const mime = attachment.mimeType ?? '';
  const isImage = mime.startsWith('image/');
  const isAudio = mime.startsWith('audio/');
  const isVideo = mime.startsWith('video/');

  if (isImage && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mt-1 max-w-[280px]">
        <img
          src={url}
          alt={attachment.name}
          className="rounded border border-ink/30 max-h-48 object-contain"
        />
      </a>
    );
  }

  if (isVideo && url) {
    return (
      <div className="mt-1 max-w-[320px]">
        <video
          src={url}
          controls
          preload="metadata"
          className="w-full rounded border border-ink/30 max-h-56 bg-black"
        />
        <DownloadChip url={url} attachment={attachment} />
      </div>
    );
  }

  if (isAudio && url) {
    return (
      <div className="mt-1 max-w-[320px] flex flex-col gap-1">
        <audio src={url} controls preload="metadata" className="w-full" />
        <DownloadChip url={url} attachment={attachment} />
      </div>
    );
  }

  // Fallback: any other mime (pdf, doc, etc.) → download chip only
  return <DownloadChip url={url} attachment={attachment} />;
}

function DownloadChip({
  url,
  attachment,
}: {
  url: string | null;
  attachment: ChatAttachment;
}) {
  return (
    <a
      href={url ?? '#'}
      target="_blank"
      rel="noreferrer"
      download={attachment.name}
      className="mt-1 inline-flex items-center gap-2 border border-ink/30 rounded px-2 py-1 bg-paper-alt text-xs max-w-full hover:bg-accent-soft"
    >
      <span>📎</span>
      <span className="truncate flex-1">{attachment.name}</span>
      <span className="text-ink-mute font-mono">
        {Math.max(1, Math.round(attachment.size / 1024))}&nbsp;KB
      </span>
    </a>
  );
}
