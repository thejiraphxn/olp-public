'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, getSessionCode, setSessionCode } from '@/lib/api';
import { confirmDialog } from '@/lib/dialog';
import { Button } from '@/components/ui/Button';
import { StatusPill, sessionStatusPillKind } from '@/components/ui/StatusPill';
import { fmtDuration } from '@/lib/format';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { StudentLive } from '@/components/live/StudentLive';
import { AttendanceSection } from '@/components/live/AttendanceSection';
import { TaskBadge } from '@/components/tasks/TaskBadge';
import { CourseRole, RecordingStatus, SessionStatus } from '@/lib/enums';
import type { ChatMessage } from '@/lib/live-types';
import { AttachmentView } from '@/components/live/AttachmentView';

type Chapter = { timeSec: number; label: string };
type TranscriptSegment = { startSec: number; endSec: number; text: string };

type ArchivedQuestion = {
  id: string;
  askedByName: string;
  text: string;
  answeredAt: string | null;
  answeredByName: string | null;
  answerText: string | null;
  createdAt: string;
};

type MainTab = 'transcript' | 'chat' | 'questions' | 'attendance';
type SubTab = 'transcript' | 'notes';

type Session = {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  // True if a 6-digit access code is set on the session. Raw `accessCode`
  // only comes through for the course's teachers.
  requiresAccessCode?: boolean;
  accessCode?: string | null;
  recording: null | {
    id: string;
    status: string;
    durationSec: number | null;
    errorMessage?: string | null;
    updatedAt?: string;
  };
};

type Playback = {
  // True when the playback URL is signed and the video is watchable.
  // We still get partial Playback responses while the recording is in
  // PROCESSING/UPLOADING (so the UI can show transcript/summary as soon
  // as the worker writes them, without waiting for everything to finish).
  ready: boolean;
  status: string;
  url: string | null;
  thumbnailUrl: string | null;
  /** Force-download presigned URL for the mp4 (Content-Disposition: attachment). */
  downloadUrl: string | null;
  /** Force-download presigned URL for the mp3 audio. */
  audioDownloadUrl: string | null;
  durationSec: number | null;
  chapters: Chapter[];
  chaptersSource: 'manual' | 'auto' | 'none';
  // `summary` is the resolved view (manual ?? auto). The raw fields are
  // there so the teacher's editor knows which one is currently active.
  summary: string | null;
  manualSummary: string | null;
  autoSummary: string | null;
  summarySource: 'manual' | 'auto' | 'none';
  transcript: TranscriptSegment[];
  // When the LLM stage failed (wrong model name, 401, network), this carries
  // the reason so the UI can explain the missing summary/auto-chapters.
  // Null = nothing failed (or success/never attempted).
  postProcessError: string | null;
  // Latest pipeline task — present once the recording has been
  // finalized at least once. `pollable` tells the UI to keep refetching
  // while the task isn't terminal.
  task: {
    id: string;
    status: import('@/lib/taskStatus').TaskStatus;
    attempts: number;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    pollable: boolean;
  } | null;
  expiresInSec: number;
};


export default function SessionPage({ params }: { params: { courseId: string; sessionId: string } }) {
  const [session, setSession] = useState<Session | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [myRole, setMyRole] = useState<CourseRole | null>(null);
  // Visibility decides whether the "Share link" button appears — sharing
  // a PRIVATE course's session URL would just 403 the recipient.
  const [courseVisibility, setCourseVisibility] = useState<string | null>(null);
  const [archivedQs, setArchivedQs] = useState<ArchivedQuestion[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [newQ, setNewQ] = useState('');
  // Inline description edit. Only available to teachers after the session
  // has ENDED — saves a PATCH to the session row, no recording rerun needed.
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeChapter, setActiveChapter] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>('transcript');
  const [subTab, setSubTab] = useState<SubTab>('transcript');
  const [activeTranscript, setActiveTranscript] = useState(0);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [startedAtPos, setStartedAtPos] = useState<number | null>(null);
  // Number of BullMQ workers connected to the recording queue. Polled only
  // for teachers, after live ended, when the recording isn't yet READY.
  // null = not yet polled (don't show rescue button until we know).
  const [workerCount, setWorkerCount] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedRef = useRef(0);
  const toast = useToast();

  // Mount: fetch everything once. Once playback is set we never refetch it —
  // the presigned URL is valid for 30 minutes, and refetching regenerates a
  // new signed URL which forces the <video> element to reload mid-playback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, course] = await Promise.all([
          api<Session>(`/courses/${params.courseId}/sessions/${params.sessionId}`),
          api<any>(`/courses/${params.courseId}`),
        ]);
        if (cancelled) return;
        setSession(s);
        setMyRole(course.myRole);
        setCourseVisibility(course.visibility ?? null);

        try {
          const p = await api<Playback>(
            `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
          );
          if (!cancelled) setPlayback(p);
        } catch {
          // not ready yet — poller below will pick it up
        }

        try {
          const cont = await api<any[]>('/progress/continue');
          const row = cont.find((x) => x.sessionId === params.sessionId);
          if (!cancelled) setStartedAtPos(row ? row.positionSec : 0);
        } catch {
          if (!cancelled) setStartedAtPos(0);
        }
      } catch (e: any) {
        // Don't let the bootstrap fetch throw an unhandled promise rejection
        // (was surfacing as a raw "API 404" overlay to anyone hitting a stale
        // or non-public link). Surface a friendly toast and leave the page in
        // its loading state — the user can navigate away.
        if (!cancelled) {
          toast.error(
            e?.body?.error
              ? `Couldn't load session: ${e.body.error}`
              : "Couldn't load this session — it may have been deleted or you don't have access.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.courseId, params.sessionId]);

  // Poll the session until the recording is READY (video playable).
  // We deliberately do NOT include `playback` in the stop condition here —
  // once we have a playback URL it's stable.
  useEffect(() => {
    if (playback) return;
    if (session?.recording?.status === RecordingStatus.READY) return;
    const t = setInterval(async () => {
      try {
        const s = await api<Session>(
          `/courses/${params.courseId}/sessions/${params.sessionId}`,
        );
        setSession(s);
        if (s.recording?.status === RecordingStatus.READY) {
          const p = await api<Playback>(
            `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
          );
          setPlayback(p);
        }
      } catch {}
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, session?.recording?.status, params.courseId, params.sessionId]);

  // Separate poller: once video is READY but transcript/summary haven't been
  // filled in yet by the worker's stage-2 post-processing, re-fetch /playback
  // (presigned URL stays the same — we only care about the metadata).
  useEffect(() => {
    if (!playback) return;
    const hasTranscript = playback.transcript && playback.transcript.length > 0;
    const hasSummary = !!playback.summary;
    if (hasTranscript && hasSummary) return; // nothing left to wait for
    const t = setInterval(async () => {
      try {
        const p = await api<Playback>(
          `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
        );
        // Only replace metadata — keep the original video URL to avoid
        // tearing down the <video> element mid-playback.
        setPlayback((prev) =>
          prev
            ? {
                ...prev,
                transcript: p.transcript,
                summary: p.summary,
                manualSummary: p.manualSummary,
                autoSummary: p.autoSummary,
                summarySource: p.summarySource,
                chapters: p.chapters,
                chaptersSource: p.chaptersSource,
                postProcessError: p.postProcessError,
                thumbnailUrl: prev.thumbnailUrl ?? p.thumbnailUrl,
              }
            : p,
        );
      } catch {}
    }, 8000);
    // Give up after 10 minutes — LLM should be done long before then.
    const timeout = setTimeout(() => clearInterval(t), 10 * 60 * 1000);
    return () => {
      clearInterval(t);
      clearTimeout(timeout);
    };
  }, [playback, params.courseId, params.sessionId]);

  // Load archived questions for this session
  useEffect(() => {
    api<ArchivedQuestion[]>(
      `/courses/${params.courseId}/sessions/${params.sessionId}/questions`,
    )
      .then(setArchivedQs)
      .catch(() => {});
  }, [params.courseId, params.sessionId]);

  // Load chat backlog so the playback view can replay the live discussion.
  useEffect(() => {
    void api<Array<Record<string, unknown>>>(
      `/courses/${params.courseId}/sessions/${params.sessionId}/uploads/messages`,
    )
      .then((rows) => {
        const msgs: ChatMessage[] = rows.map((m) => ({
          id: String(m.id),
          sessionId: String(m.sessionId),
          userId: String(m.userId ?? ''),
          userName: String(m.userName ?? m.guestName ?? 'Guest'),
          userRole: 'STUDENT' as ChatMessage['userRole'],
          text: String(m.text ?? ''),
          attachment: m.attachmentKey
            ? {
                key: String(m.attachmentKey),
                name: String(m.attachmentName ?? 'attachment'),
                mimeType: String(
                  m.attachmentMimeType ?? 'application/octet-stream',
                ),
                size: Number(m.attachmentSize ?? 0),
              }
            : null,
          createdAt:
            m.createdAt instanceof Date
              ? m.createdAt.toISOString()
              : String(m.createdAt),
        }));
        setChatHistory(msgs);
      })
      .catch(() => {});
  }, [params.courseId, params.sessionId]);

  // Poll the BullMQ worker count — only for the teacher of an ENDED session
  // whose post-processing isn't fully done. Failure modes that land here:
  //   1. status !== READY      — transcode never ran (worker offline at upload time)
  //   2. READY, no transcript  — Whisper stage failed / worker died after transcode
  //   3. READY, transcript ok but no summary — LLM stage failed / worker died later
  // In every case the BullMQ job is either stuck in `waiting` (case 1) or
  // already shows `completed` (cases 2-3 — the worker's task function caught
  // and swallowed the LLM error to avoid losing the video). Re-enqueue is
  // the only path that runs the missing steps.
  // If `workerCount === 0`, the embedded worker is gone (crashed / Redis
  // disconnected) and queued jobs will sit forever until someone re-enqueues.
  useEffect(() => {
    if (myRole !== CourseRole.TEACHER) return;
    if (session?.status !== SessionStatus.ENDED) return;
    const recStatus = session.recording?.status;
    if (!recStatus) return;
    const transcriptDone = (playback?.transcript?.length ?? 0) > 0;
    const summaryDone = !!playback?.summary;
    if (recStatus === RecordingStatus.READY && transcriptDone && summaryDone) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await api<{ active: number }>(
          '/admin/queue/recording/workers',
        );
        if (!cancelled) setWorkerCount(r.active);
      } catch {
        // 403 (not a global teacher) or 5xx — leave count null so we don't
        // accidentally surface the rescue button.
      }
    };
    void poll();
    const t = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [
    myRole,
    session?.status,
    session?.recording?.status,
    playback?.transcript,
    playback?.summary,
  ]);

  async function saveDescription() {
    if (!session) return;
    const trimmed = descriptionDraft.trim();
    if (trimmed === (session.description ?? '')) {
      setEditingDescription(false);
      return;
    }
    setSavingDescription(true);
    try {
      const updated = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
        { method: 'PATCH', body: { description: trimmed || null } },
      );
      setSession((s) => (s ? { ...s, description: updated.description } : s));
      setEditingDescription(false);
      toast.success('Description saved');
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to save');
    } finally {
      setSavingDescription(false);
    }
  }

  async function askAsyncQuestion() {
    if (!newQ.trim()) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${params.sessionId}/questions`, {
        method: 'POST',
        body: { text: newQ },
      });
      setNewQ('');
      toast.success('Question submitted — the teacher will see it');
      const list = await api<ArchivedQuestion[]>(
        `/courses/${params.courseId}/sessions/${params.sessionId}/questions`,
      );
      setArchivedQs(list);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  // Seek to saved position once the video has metadata
  useEffect(() => {
    const v = videoRef.current;
    if (!v || startedAtPos === null || startedAtPos <= 0 || !playback) return;
    const onLoaded = () => {
      if (v.currentTime < 1 && startedAtPos < (v.duration || Infinity) - 5) {
        v.currentTime = startedAtPos;
      }
    };
    v.addEventListener('loadedmetadata', onLoaded);
    return () => v.removeEventListener('loadedmetadata', onLoaded);
  }, [playback, startedAtPos]);

  // Persist progress every 10s + on pause/ended
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playback) return;
    const save = async (completed = false) => {
      const t = Math.round(v.currentTime);
      if (!completed && Math.abs(t - lastSavedRef.current) < 10) return;
      lastSavedRef.current = t;
      try {
        await api('/progress', {
          method: 'PUT',
          body: { sessionId: params.sessionId, positionSec: t, completed },
        });
      } catch {}
    };
    const onTime = () => {
      const t = v.currentTime;
      const chapters = playback.chapters ?? [];
      let ci = 0;
      for (let i = 0; i < chapters.length; i++) if (t >= chapters[i].timeSec) ci = i;
      setActiveChapter(ci);
      const tr = playback.transcript ?? [];
      let ti = 0;
      for (let i = 0; i < tr.length; i++) if (t >= tr[i].startSec) ti = i;
      setActiveTranscript(ti);
      save(false);
    };
    const onPause = () => save(false);
    const onEnded = () => save(true);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback]);

  async function retry() {
    if (!session?.recording?.id) return;
    try {
      await api(
        `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${session.recording.id}/retry`,
        { method: 'POST' },
      );
      toast.info('Re-running post-processing…');
      // Keep the existing playback visible — the worker reuses the mp4 +
      // transcript when they're already there, so the user shouldn't see
      // the page go dark while only the LLM stage retries. The metadata
      // poller picks up the new summary / chapters as soon as the worker
      // saves them.
      const s = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
      );
      setSession(s);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  async function resetRecording() {
    if (!session?.recording?.id) return;
    const ok = await confirmDialog(
      'The stuck recording will be wiped and the session reverts to SCHEDULED so you can start fresh.',
      { title: 'Reset this recording?', confirmText: 'Reset', danger: true },
    );
    if (!ok) return;
    try {
      await api(
        `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${session.recording.id}/reset`,
        { method: 'POST' },
      );
      toast.success('Recording reset — you can start a new one');
      setPlayback(null);
      const s = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
      );
      setSession(s);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'reset failed');
    }
  }

  // Detect a recording that's been "processing" for an unreasonably long time.
  // A normal 1-minute recording transcodes in < 1 minute; if it's been stuck
  // for more than 5 minutes something went wrong — offer a reset.
  const stuckThresholdMs = 5 * 60 * 1000;
  const isStuck =
    session?.recording &&
    (session.recording.status === RecordingStatus.PROCESSING ||
      session.recording.status === RecordingStatus.UPLOADING) &&
    Date.now() - new Date((session.recording as any).updatedAt ?? Date.now()).getTime() >
      stuckThresholdMs;

  function seekTo(sec: number) {
    if (!videoRef.current) return;
    videoRef.current.currentTime = sec;
    videoRef.current.play().catch(() => {});
  }

  if (loading)
    return (
      <div className="p-6 flex flex-col gap-4 max-w-6xl">
        <Skeleton className="h-8 w-60" />
        <div className="grid grid-cols-[1.6fr_1fr] gap-5">
          <Skeleton className="aspect-video" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  if (!session) return null;

  // Soft 6-digit gate. Everyone — including the teacher who set the code —
  // has to type it once per browser session. The teacher gets the raw value
  // shown as a hint inside the modal so it's a confirm step, not a memory
  // test. We stash in sessionStorage so subsequent fetches + socket connects
  // auto-include the X-Session-Code header.
  const needsGate =
    !!session.requiresAccessCode && !getSessionCode(session.id);
  if (needsGate) {
    return (
      <SessionCodeGate
        courseId={params.courseId}
        sessionId={params.sessionId}
        sessionTitle={session.title}
        teacherHint={
          myRole === CourseRole.TEACHER ? session.accessCode ?? null : null
        }
        onAccepted={(code) => {
          setSessionCode(session.id, code);
          // Re-run bootstrap to fetch playback now that the header is wired.
          window.location.reload();
        }}
      />
    );
  }

  // Live takeover: if session is currently LIVE and viewer isn't the teacher,
  // hand the entire viewport to the StudentLive shell (matches the teacher's
  // record-page fullscreen layout — top bar, main video, users rail, side
  // panel, control bar). Treats guests (myRole === null on PUBLIC courses)
  // the same as enrolled students.
  if (session.status === SessionStatus.LIVE && myRole !== CourseRole.TEACHER) {
    return (
      <StudentLive
        courseId={params.courseId}
        sessionId={params.sessionId}
        sessionTitle={session.title}
      />
    );
  }

  const recStatus = session.recording?.status;
  // Use the backend's `ready` flag — it bundles status + playbackKey check
  // together. The transcript/summary panes don't need this; they render the
  // moment their data is available, even mid-PROCESSING.
  const ready = !!playback?.ready && !!playback.url;
  const chapters = playback?.chapters ?? [];

  if (focusMode && ready) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 text-white border-b border-zinc-800">
          <button
            onClick={() => setFocusMode(false)}
            className="h-8 px-3 rounded border border-zinc-600 text-sm hover:bg-white/5"
          >
            ← Exit focus
          </button>
          <div className="min-w-0">
            <div className="text-[10px] font-mono text-zinc-500 uppercase">Session</div>
            <div className="font-bold text-sm truncate">{session.title}</div>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center p-8">
          <video
            ref={videoRef}
            src={playback?.url ?? undefined}
            poster={playback?.thumbnailUrl ?? undefined}
            controls
            autoPlay
            className="w-full h-full max-w-full max-h-full object-contain"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[11px] text-ink-mute">
            <Link href={`/courses/${params.courseId}`} className="hover:underline">
              ← back to course
            </Link>
          </div>
          <h1 className="text-xl font-bold mt-1">{session.title}</h1>
        </div>
        <div className="flex gap-2 items-center">
          <StatusPill kind={sessionStatusPillKind(session.status, recStatus)} />
          {playback?.task && (
            <TaskBadge
              status={playback.task.status}
              attempts={playback.task.attempts}
              errorMessage={playback.task.errorMessage}
            />
          )}
          {ready && (
            <Button variant="ghost" size="sm" onClick={() => setFocusMode(true)}>
              ⛶ Focus
            </Button>
          )}
          {courseVisibility === 'PUBLIC' && (
            <Button
              variant="ghost"
              size="sm"
              title="Copy public link to this session"
              onClick={() => {
                const url = `${window.location.origin}/courses/${params.courseId}/sessions/${params.sessionId}`;
                navigator.clipboard.writeText(url);
                toast.info('Copied session link');
              }}
            >
              🔗 Share
            </Button>
          )}
          {/* Download is teacher-only. The backend already returns null for
              non-teachers; this UI check is defense-in-depth. */}
          {ready && myRole === CourseRole.TEACHER && playback?.downloadUrl && (
            <a
              href={playback.downloadUrl}
              download
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-ink/30 text-sm font-semibold hover:bg-paper-alt"
              title="Download the recording (mp4) — teacher only"
            >
              ⬇ Download
            </a>
          )}
          {myRole === CourseRole.TEACHER && (recStatus === RecordingStatus.FAILED || recStatus === RecordingStatus.PROCESSING) && (
            <Button variant={recStatus === RecordingStatus.FAILED ? 'danger' : 'ghost'} onClick={retry}>
              {recStatus === RecordingStatus.FAILED ? 'Retry processing' : 'Nudge worker'}
            </Button>
          )}
          {(() => {
            if (myRole !== CourseRole.TEACHER) return null;
            if (session.status !== SessionStatus.ENDED) return null;
            if (!recStatus) return null;
            const transcriptDone = (playback?.transcript?.length ?? 0) > 0;
            const summaryDone = !!playback?.summary;
            // Pick the most-specific label for *missing* artefacts, but
            // still render the button even when everything is done — the
            // teacher may want to re-run post-processing to try a new
            // model / prompt / language hint.
            let what: string;
            let variant: 'danger' | 'primary' | 'ghost';
            let tooltip: string;
            const noWorker = workerCount === 0;
            if (recStatus !== RecordingStatus.READY) {
              what = 'Trigger processing';
              variant = noWorker ? 'danger' : 'primary';
              tooltip = noWorker
                ? 'No worker is connected. Click to re-enqueue so the next worker that boots picks it up.'
                : 'Re-run post-processing. The video file is reused — only the missing piece is regenerated.';
            } else if (!transcriptDone) {
              what = 'Re-generate transcript';
              variant = noWorker ? 'danger' : 'primary';
              tooltip = 'Re-run transcription. The video file is reused.';
            } else if (!summaryDone) {
              what = 'Re-generate summary';
              variant = noWorker ? 'danger' : 'primary';
              tooltip = 'Re-run the LLM summary + auto-chapters. The video file is reused.';
            } else {
              // Everything is already done — offer a low-key re-run for
              // the case where the teacher wants a fresh transcript /
              // summary (e.g. after swapping Whisper model or LLM prompt).
              what = 'Re-generate';
              variant = 'ghost';
              tooltip =
                'Re-run transcript + summary against the existing video. The mp4 stays watchable while the regen is in progress.';
            }
            const suffix = noWorker ? ' (no worker)' : '';
            return (
              <Button variant={variant} onClick={retry} title={tooltip}>
                ⚡ {what}
                {suffix}
              </Button>
            );
          })()}
          {myRole === CourseRole.TEACHER && isStuck && (
            <Button variant="danger" onClick={resetRecording}>
              ✕ Reset (stuck)
            </Button>
          )}
          {myRole === CourseRole.TEACHER && !ready && recStatus !== RecordingStatus.PROCESSING && recStatus !== RecordingStatus.FAILED && (
            <Link href={`/courses/${params.courseId}/sessions/${params.sessionId}/record`}>
              <Button variant="primary">
                {session.status === SessionStatus.LIVE ? 'Continue teaching' : 'Start recording'}
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-5">
        <div className="flex flex-col gap-3 min-w-0">
          <div className="aspect-video bg-black border border-ink rounded overflow-hidden relative">
            {ready ? (
              <video
                ref={videoRef}
                src={playback?.url ?? undefined}
                poster={playback?.thumbnailUrl ?? undefined}
                controls
                className="w-full h-full"
              />
            ) : (
              <NotReadyOverlay status={recStatus ?? RecordingStatus.PENDING} errorMsg={session.recording?.errorMessage} />
            )}
          </div>

          {(playback?.summary || myRole === CourseRole.TEACHER) && session.recording?.id && (
            <SummaryCard
              courseId={params.courseId}
              sessionId={params.sessionId}
              recordingId={session.recording.id}
              manualSummary={playback?.manualSummary ?? null}
              autoSummary={playback?.autoSummary ?? null}
              source={playback?.summarySource ?? 'none'}
              canEdit={myRole === CourseRole.TEACHER}
              onSaved={(manual) =>
                setPlayback((prev) =>
                  prev
                    ? {
                        ...prev,
                        manualSummary: manual,
                        summary: manual ?? prev.autoSummary,
                        summarySource: manual ? 'manual' : prev.autoSummary ? 'auto' : 'none',
                      }
                    : prev,
                )
              }
            />
          )}

          {/* LLM stage failed for whatever reason (wrong model, 401, network).
              Shown only to teachers — students don't need the diagnostic. */}
          {myRole === CourseRole.TEACHER && playback?.postProcessError && !playback?.summary && (
            <div className="border border-warn bg-warn-soft/40 rounded p-3.5 text-sm">
              <div className="text-[11px] font-semibold text-warn mb-1">
                AI POST-PROCESSING FAILED
              </div>
              <div className="text-xs text-ink leading-relaxed font-mono break-all">
                {playback.postProcessError}
              </div>
              <div className="text-[11px] text-ink-soft mt-2">
                Common causes: <code>LLM_MODEL</code> not available on the
                provider, <code>LLM_API_KEY</code> wrong, or the LLM endpoint
                returned an error. The video itself is fine — only the
                summary / auto-chapters are missing.
              </div>
            </div>
          )}

          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft mb-2 flex items-center gap-2">
              <span>CHAPTERS {chapters.length > 0 && `· ${chapters.length}`}</span>
              {playback?.chaptersSource === 'auto' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/40">
                  AI-generated
                </span>
              )}
            </div>
            {!ready ? (
              <div className="text-xs text-ink-mute">Available once the recording is ready.</div>
            ) : chapters.length === 0 ? (
              <div className="text-xs text-ink-mute">No chapters were marked for this recording.</div>
            ) : (
              <ol className="text-sm">
                {chapters.map((c, i) => (
                  <li
                    key={i}
                    onClick={() => seekTo(c.timeSec)}
                    className={[
                      'flex gap-3 py-1.5 px-2 -mx-2 rounded cursor-pointer hover:bg-paper-alt items-center border-b last:border-b-0 border-dashed border-ink/10',
                      i === activeChapter ? 'bg-accent-soft text-accent font-bold' : '',
                    ].join(' ')}
                  >
                    <span className="font-mono text-xs w-12 text-ink-mute">
                      {fmtDuration(c.timeSec)}
                    </span>
                    <span className="flex-1">{c.label}</span>
                    {i === activeChapter && <span>▶</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft flex justify-between items-center">
              <span>DESCRIPTION</span>
              {/* Editable only after the live ended. Hidden during DRAFT/SCHEDULED
                  (use the course → session edit form for those) and during LIVE
                  (avoids accidental edits while presenting). */}
              {myRole === CourseRole.TEACHER &&
                session.status === SessionStatus.ENDED &&
                !editingDescription && (
                  <button
                    onClick={() => {
                      setDescriptionDraft(session.description ?? '');
                      setEditingDescription(true);
                    }}
                    className="text-[11px] font-semibold text-accent hover:underline"
                  >
                    Edit
                  </button>
                )}
            </div>
            {editingDescription ? (
              <div className="mt-1 flex flex-col gap-2">
                <textarea
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="What was this session about?"
                  className="w-full px-2 py-1.5 border border-ink rounded text-sm resize-y"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingDescription(false)}
                    disabled={savingDescription}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={saveDescription}
                    disabled={savingDescription}
                  >
                    {savingDescription ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm mt-1 whitespace-pre-wrap break-words">
                {session.description ?? '—'}
              </div>
            )}
          </div>

          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft">DETAILS</div>
            <ul className="text-sm mt-2 space-y-1">
              <li>
                Scheduled:{' '}
                <b>{session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : '—'}</b>
              </li>
              <li>
                Duration: <b>{fmtDuration(session.recording?.durationSec)}</b>
              </li>
              <li>
                Recording: <b>{recStatus ?? 'none'}</b>
              </li>
            </ul>
          </div>

          {/* One-stop tabbed panel: transcript+note, chat replay, questions,
              attendance. Attendance tab is teacher-only — backend gates it. */}
          <div className="border border-ink rounded overflow-hidden flex flex-col min-h-0">
            <div className="flex border-b border-ink bg-paper-alt overflow-x-auto">
              {(
                [
                  { key: 'transcript', label: 'Transcript / Note' },
                  {
                    key: 'chat',
                    label: `Chat${chatHistory.length > 0 ? ` · ${chatHistory.length}` : ''}`,
                  },
                  {
                    key: 'questions',
                    label: `Questions${archivedQs.length > 0 ? ` · ${archivedQs.length}` : ''}`,
                  },
                  ...(myRole === CourseRole.TEACHER
                    ? [{ key: 'attendance' as const, label: 'Attendance' }]
                    : []),
                ] as { key: MainTab; label: string }[]
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setMainTab(t.key)}
                  className={[
                    'py-2 px-3 -mb-px font-semibold text-sm whitespace-nowrap',
                    mainTab === t.key
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-ink-soft hover:text-ink',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {mainTab === 'transcript' && (
              <div>
                <div className="flex gap-4 border-b border-ink px-3 bg-paper">
                  {(['transcript', 'notes'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setSubTab(t)}
                      className={[
                        'py-1.5 -mb-px font-semibold capitalize text-xs',
                        subTab === t
                          ? 'border-b-2 border-accent text-accent'
                          : 'text-ink-soft hover:text-ink',
                      ].join(' ')}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {subTab === 'transcript' && (
                  <TranscriptPane
                    ready={!!ready}
                    transcript={playback?.transcript ?? []}
                    activeIndex={activeTranscript}
                    search={transcriptSearch}
                    setSearch={setTranscriptSearch}
                    onSeek={seekTo}
                  />
                )}
                {subTab === 'notes' && (
                  <div className="p-3 text-xs text-ink-mute">
                    Private notes per user are a Phase 2 feature.
                  </div>
                )}
              </div>
            )}

            {mainTab === 'chat' && (
              <ChatHistoryPane
                messages={chatHistory}
                courseId={params.courseId}
                sessionId={params.sessionId}
              />
            )}

            {mainTab === 'questions' && (
              <div className="p-3 flex flex-col gap-3">
                {myRole === CourseRole.STUDENT && (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      askAsyncQuestion();
                    }}
                  >
                    <input
                      value={newQ}
                      onChange={(e) => setNewQ(e.target.value)}
                      placeholder="Ask even after the session ends…"
                      className="flex-1 h-9 px-2 border border-ink rounded text-sm"
                    />
                    <Button type="submit" variant="primary" size="sm" disabled={!newQ.trim()}>
                      Ask
                    </Button>
                  </form>
                )}
                <div className="flex flex-col gap-2 max-h-[480px] overflow-auto">
                  {archivedQs.length === 0 ? (
                    <div className="text-xs text-ink-mute">No questions yet.</div>
                  ) : (
                    archivedQs.map((q) => (
                      <div
                        key={q.id}
                        className="border border-ink/30 rounded p-2 flex flex-col gap-1 bg-paper"
                      >
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="font-bold text-xs">{q.askedByName}</span>
                          <span className="font-mono text-[10px] text-ink-mute">
                            {new Date(q.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="text-sm">{q.text}</div>
                        {q.answerText && (
                          <div className="mt-1 border-l-2 border-accent pl-2 text-sm bg-accent-soft/30 rounded py-1">
                            <div className="text-[10px] text-accent font-bold">
                              ANSWERED by {q.answeredByName}
                            </div>
                            {q.answerText}
                          </div>
                        )}
                        {!q.answeredAt && (
                          <span className="text-[10px] font-bold text-warn">unanswered</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {mainTab === 'attendance' && myRole === CourseRole.TEACHER && (
              <div className="p-3">
                <AttendanceSection
                  courseId={params.courseId}
                  sessionId={params.sessionId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionCodeGate({
  courseId,
  sessionId,
  sessionTitle,
  teacherHint,
  onAccepted,
}: {
  courseId: string;
  sessionId: string;
  sessionTitle: string;
  /** Raw code shown only to the teacher of this course as a memory aid. */
  teacherHint: string | null;
  onAccepted: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setErr('Code must be 6 digits.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await api(`/courses/${courseId}/sessions/${sessionId}/verify-code`, {
        method: 'POST',
        body: { code },
      });
      onAccepted(code);
    } catch (e: any) {
      setErr(
        e?.status === 401
          ? 'Wrong code — check with the teacher.'
          : (e?.body?.error ?? 'failed to verify'),
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm border border-ink rounded p-6 bg-paper-alt shadow-[3px_3px_0_rgba(0,0,0,0.08)]"
      >
        <div className="text-[11px] font-mono text-ink-mute mb-1">PROTECTED SESSION</div>
        <h1 className="text-xl font-bold mb-1">{sessionTitle}</h1>
        <p className="text-xs text-ink-soft mb-4">
          The teacher set a 6-digit access code for this session. Enter it to view.
        </p>
        {teacherHint && (
          <div className="border border-accent bg-accent-soft/40 rounded p-2.5 mb-3 text-[11px] text-ink leading-relaxed">
            <span className="font-bold text-accent">Teacher reminder:</span>{' '}
            the code for this session is{' '}
            <span className="font-mono font-bold">{teacherHint}</span>
          </div>
        )}
        <input
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="• • • • • •"
          className="w-full h-12 text-center text-2xl tracking-[0.4em] font-mono border border-ink rounded bg-paper"
        />
        {err && (
          <div className="mt-3 border border-live bg-live-soft text-live text-xs px-3 py-2 rounded">
            {err}
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || code.length !== 6}
          className="w-full mt-4"
        >
          {submitting ? 'Verifying…' : '→ Enter session'}
        </Button>
      </form>
    </div>
  );
}

function SummaryCard({
  courseId,
  sessionId,
  recordingId,
  manualSummary,
  autoSummary,
  source,
  canEdit,
  onSaved,
}: {
  courseId: string;
  sessionId: string;
  recordingId: string;
  manualSummary: string | null;
  autoSummary: string | null;
  source: 'manual' | 'auto' | 'none';
  canEdit: boolean;
  onSaved: (manual: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(manualSummary ?? autoSummary ?? '');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  // Reset draft when the underlying values change (e.g. AI just finished
  // generating its version while the editor wasn't open).
  useEffect(() => {
    if (!editing) setDraft(manualSummary ?? autoSummary ?? '');
  }, [manualSummary, autoSummary, editing]);

  const resolved = manualSummary ?? autoSummary;
  if (!resolved && !canEdit) return null;

  async function save(text: string | null) {
    setSaving(true);
    try {
      await api(`/courses/${courseId}/sessions/${sessionId}/recordings/${recordingId}/summary`, {
        method: 'PUT',
        body: { text: text ?? '' },
      });
      onSaved(text);
      setEditing(false);
      toast.success(text ? 'Summary saved' : 'Reverted to AI summary');
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-accent bg-accent-soft/40 rounded p-3.5">
      <div className="text-[11px] font-semibold text-accent mb-1 flex items-center gap-2 flex-wrap">
        <span>SUMMARY</span>
        {source === 'auto' && (
          <span className="text-[9px] font-normal text-ink-mute px-1.5 py-0.5 rounded bg-paper-alt border border-ink-mute/40">
            AI-generated
          </span>
        )}
        {source === 'manual' && (
          <span className="text-[9px] font-normal text-ok px-1.5 py-0.5 rounded bg-ok-soft border border-ok/40">
            by teacher
          </span>
        )}
        <div className="flex-1" />
        {canEdit && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[10px] font-semibold text-accent hover:underline"
          >
            ✎ Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Write the lecture summary in your own words…"
            className="w-full p-2 border border-ink rounded text-sm bg-paper resize-y"
          />
          <div className="flex gap-2 items-center text-[10px] text-ink-mute">
            <span>{draft.length} / 2000</span>
            <div className="flex-1" />
            {manualSummary && autoSummary && (
              <button
                type="button"
                onClick={() => save(null)}
                disabled={saving}
                className="text-ink-soft hover:underline"
                title="Delete your manual override and show the AI summary instead"
              >
                Use AI version
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDraft(manualSummary ?? autoSummary ?? '');
                setEditing(false);
              }}
              className="text-ink-soft hover:underline"
            >
              Cancel
            </button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => save(draft.trim() || null)}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : resolved ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap">{resolved}</div>
      ) : (
        <div className="text-xs text-ink-mute italic">
          No summary yet. Click ✎ Edit to write one.
        </div>
      )}
    </div>
  );
}

function TranscriptPane({
  ready,
  transcript,
  activeIndex,
  search,
  setSearch,
  onSeek,
}: {
  ready: boolean;
  transcript: TranscriptSegment[];
  activeIndex: number;
  search: string;
  setSearch: (s: string) => void;
  onSeek: (t: number) => void;
}) {
  const query = search.trim().toLowerCase();
  const matches =
    query.length > 0
      ? transcript
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.text.toLowerCase().includes(query))
      : null;

  // Auto-scroll the active segment into view as the video plays. Track
  // per-segment refs in a Map (cleaner than a sparse array) and seek with
  // `block: 'center'` so the highlighted line lives in the middle of
  // the scroll container — easy to read ahead.
  const segmentRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Skip auto-scroll while the user is typing in the search box — they
  // expect the list to stay anchored on whatever they're scanning.
  useEffect(() => {
    if (query) return;
    const el = segmentRefs.current.get(activeIndex);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex, query]);

  // If we have transcript data, render it — even when video isn't ready yet.
  // Whisper finishes ahead of LLM/transcode in most flows, so transcripts
  // become readable while the rest of post-processing still runs.
  if (transcript.length === 0) {
    if (!ready) {
      return (
        <div className="p-3 text-xs text-ink-mute">
          Transcript is generated automatically after the recording processes.
          If no Whisper provider is configured on the server, no transcript is
          produced.
        </div>
      );
    }
    return (
      <div className="p-3 flex items-center gap-2 text-xs text-ink-mute">
        <div
          className="w-3 h-3 rounded-full border-2 border-warn border-t-transparent animate-spin-slow"
          aria-hidden
        />
        <span>
          Transcript is still generating in the background — this page will update
          automatically when it's ready (usually 30 s – 2 min after the recording
          becomes available).
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="px-2 pt-2">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-mute text-sm">
            ⌕
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search spoken text…"
            className="h-8 pl-7 pr-2 w-full border border-ink rounded text-sm"
          />
        </div>
        {matches && (
          <div className="text-[10px] font-mono text-ink-mute mt-1">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </div>
        )}
      </div>
      <div
        ref={containerRef}
        className="max-h-80 overflow-auto p-2.5 flex flex-col gap-1.5 text-sm"
      >
        {(matches ?? transcript.map((s, i) => ({ s, i }))).map(({ s, i }) => {
          const isActive = i === activeIndex && !query;
          return (
            <button
              key={i}
              ref={(el) => {
                if (el) segmentRefs.current.set(i, el);
                else segmentRefs.current.delete(i);
              }}
              onClick={() => onSeek(s.startSec)}
              className={[
                'flex gap-2.5 text-left hover:bg-paper-alt rounded px-1.5 py-1 scroll-mt-2',
                isActive ? 'bg-accent-soft' : '',
              ].join(' ')}
            >
              <span className="font-mono text-[11px] text-ink-mute w-12 flex-shrink-0 pt-0.5">
                {fmtDuration(s.startSec)}
              </span>
              <span className={isActive ? 'text-accent font-semibold' : ''}>
                {query ? <HighlightedText text={s.text} term={query} /> : s.text}
              </span>
            </button>
          );
        })}
        {matches && matches.length === 0 && (
          <div className="text-xs text-ink-mute text-center py-4">
            No match for "{search}"
          </div>
        )}
      </div>
    </>
  );
}

function HighlightedText({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(term, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={hit} className="bg-warn-soft text-warn px-0.5 rounded">
        {text.slice(hit, hit + term.length)}
      </mark>,
    );
    i = hit + term.length;
  }
  return <>{parts}</>;
}

function NotReadyOverlay({
  status,
  errorMsg,
}: {
  status: string;
  errorMsg?: string | null;
}) {
  if (status === RecordingStatus.PROCESSING || status === RecordingStatus.UPLOADING) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
        <div
          className="w-12 h-12 rounded-full border-[3px] border-warn border-t-transparent animate-spin-slow"
          aria-hidden
        />
        <div className="font-bold">Processing recording…</div>
        <div className="text-xs text-zinc-400">usually 30 s – 5 min · this page auto-refreshes</div>
      </div>
    );
  }
  if (status === RecordingStatus.FAILED) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2 px-8 text-center">
        <div className="text-live font-bold text-lg">Recording failed</div>
        <div className="text-xs text-zinc-400">{errorMsg ?? 'The encoder returned an error.'}</div>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
      <div className="font-bold">No recording yet</div>
      <div className="text-xs text-zinc-400">The session hasn't been recorded.</div>
    </div>
  );
}

function ChatHistoryPane({
  messages,
  courseId,
  sessionId,
}: {
  messages: ChatMessage[];
  courseId: string;
  sessionId: string;
}) {
  if (messages.length === 0) {
    return (
      <div className="p-3 text-xs text-ink-mute">
        No chat messages were sent during this session.
      </div>
    );
  }
  return (
    <div className="p-3 flex flex-col gap-2 max-h-[480px] overflow-auto">
      {messages.map((m) => (
        <div
          key={m.id}
          className="border border-ink/30 rounded p-2 bg-paper flex flex-col gap-0.5"
        >
          <div className="flex justify-between items-baseline gap-2">
            <span className="font-bold text-xs">{m.userName}</span>
            <span className="font-mono text-[10px] text-ink-mute">
              {new Date(m.createdAt).toLocaleString()}
            </span>
          </div>
          {m.text && <div className="text-sm whitespace-pre-wrap break-words">{m.text}</div>}
          {m.attachment && (
            <AttachmentView
              attachment={m.attachment}
              courseId={courseId}
              sessionId={sessionId}
            />
          )}
        </div>
      ))}
    </div>
  );
}
