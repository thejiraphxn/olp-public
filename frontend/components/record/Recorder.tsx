'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDuration } from '@/lib/format';

const PART_MIN_BYTES = 5 * 1024 * 1024;

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'done'
  | 'error';

type Chapter = { timeSec: number; label: string };

/**
 * Captures screen + mic, records via MediaRecorder, and uploads as S3 multipart.
 * Also exposes the live stream via `onStream` so the page can publish it via WebRTC.
 */
export function Recorder({
  courseId,
  sessionId,
  autoStart,
  startSignal = 0,
  stopSignal = 0,
  existingMicStream,
  recordingAudioStream,
  onStatus,
  onComplete,
  onRecordingIdChange,
  onStream,
}: {
  courseId: string;
  sessionId: string;
  autoStart?: boolean;
  // Increment this value to request start from parent (e.g. control bar).
  startSignal?: number;
  // Increment this value to request stop from parent (e.g. control bar).
  stopSignal?: number;
  /** Mic stream sent to the WebRTC mesh + the local preview. Acquired during
   *  pre-flight; reused so the browser doesn't re-prompt for permission.
   *  Stable across the recording — never swap mid-session. */
  existingMicStream?: MediaStream | null;
  /** Optional separate audio source for the MediaRecorder only. When set,
   *  this stream's audio track is what ends up in the mp4 — mesh students
   *  still hear `existingMicStream` straight. Used to bake the participant-
   *  audio mixer into the recording without disturbing the live broadcast. */
  recordingAudioStream?: MediaStream | null;
  onStatus?: (s: RecorderStatus) => void;
  onComplete: () => void;
  onRecordingIdChange?: (id: string | null) => void;
  onStream?: (stream: MediaStream | null) => void;
}) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterDraft, setChapterDraft] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  // Guards against React Strict Mode double-invoking the autoStart effect,
  // which otherwise opens the screen picker twice.
  const startGuardRef = useRef(false);
  const bufferRef = useRef<Blob[]>([]);
  const bufferBytesRef = useRef(0);
  const partNumberRef = useRef(1);
  const partsRef = useRef<{ PartNumber: number; ETag: string }[]>([]);
  const pendingFlushesRef = useRef<Promise<void>[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStartSignalRef = useRef(startSignal);
  const lastStopSignalRef = useRef(stopSignal);

  const setS = useCallback(
    (s: RecorderStatus) => {
      setStatus(s);
      onStatus?.(s);
    },
    [onStatus],
  );

  async function flushPart(final: boolean) {
    if (bufferRef.current.length === 0) return;
    if (!final && bufferBytesRef.current < PART_MIN_BYTES) return;
    const blob = new Blob(bufferRef.current, { type: 'video/webm' });
    bufferRef.current = [];
    bufferBytesRef.current = 0;
    const partNumber = partNumberRef.current++;
    const { url } = await api<{ url: string; partNumber: number }>(
      `/courses/${courseId}/sessions/${sessionId}/recordings/${recordingIdRef.current}/part-url`,
      { method: 'POST', body: { partNumber } },
    );
    const res = await fetch(url, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`upload part ${partNumber} failed (${res.status})`);
    const etag = res.headers.get('ETag')?.replace(/"/g, '') ?? '';
    if (!etag) throw new Error('S3 did not return ETag — check CORS config');
    partsRef.current.push({ PartNumber: partNumber, ETag: etag });
    setUploaded((u) => u + blob.size);
  }

  const stop = useCallback(async () => {
    if (status !== 'recording') return;
    setS('stopping');
    try {
      // Stop the recorder (asynchronously flushes any pending data).
      try {
        recorderRef.current?.stop();
      } catch {}
      recorderRef.current = null;

      // Stop every track that we've ever touched — the merged stream, the
      // pre-flight mic that was handed to us, and the raw screen-capture
      // MediaStream (accessed via srcObject on the <video>). We can't
      // assume they share references in every browser, so we call stop()
      // on each explicitly.
      const stopAll = (s: MediaStream | null | undefined) => {
        s?.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      };
      stopAll(streamRef.current);
      // existingMicStream might have been kept alive by pre-flight. Stop here.
      stopAll(existingMicStream);
      // Release the <video> reference so the browser can drop its internal
      // hold on the stream (some browsers keep the screen-share indicator
      // lit until srcObject is cleared).
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
        videoRef.current.load();
      }
      streamRef.current = null;

      // Tell the parent (useLiveRoom) to unpublish from all peer connections.
      onStream?.(null);
      if (timerRef.current) clearInterval(timerRef.current);

      await new Promise((r) => setTimeout(r, 250));
      await Promise.all(pendingFlushesRef.current);
      await flushPart(true);

      setS('uploading');
      await api(
        `/courses/${courseId}/sessions/${sessionId}/recordings/${recordingIdRef.current}/complete`,
        { method: 'POST', body: { parts: partsRef.current } },
      );
      if (chapters.length > 0) {
        await api(
          `/courses/${courseId}/sessions/${sessionId}/recordings/${recordingIdRef.current}/chapters`,
          { method: 'PUT', body: { chapters } },
        );
      }
      setS('done');
      onComplete();
    } catch (e: any) {
      setError(e.message ?? 'failed');
      setS('error');
    }
  }, [courseId, sessionId, status, chapters, onComplete, onStream, setS]);

  async function start() {
    setError(null);
    setS('starting');
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      // Reuse the pre-flight mic stream if it still has live tracks;
      // otherwise request a fresh one. This prevents "silent recording"
      // when the preflight track was stopped/lost for any reason.
      const preflightLive =
        existingMicStream?.getAudioTracks().filter((t) => t.readyState === 'live') ?? [];
      const mic =
        preflightLive.length > 0
          ? existingMicStream!
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true },
            });
      const meshAudioTracks = mic.getAudioTracks();
      if (meshAudioTracks.length === 0) {
        throw new Error('no microphone audio track — check permissions');
      }
      // Live mesh + local preview always uses the raw mic. Stable across
      // the session so toggling the participant-mixer can't hiccup what
      // students hear.
      const merged = new MediaStream([
        ...screen.getVideoTracks(),
        ...meshAudioTracks,
      ]);
      // Recording audio: prefer the dedicated recording-only stream
      // (e.g. the participant-audio mixer); fall back to the mic itself.
      const recordingAudioTracks =
        recordingAudioStream?.getAudioTracks().filter((t) => t.readyState === 'live') ?? [];
      const recordingStream =
        recordingAudioTracks.length > 0
          ? new MediaStream([...screen.getVideoTracks(), ...recordingAudioTracks])
          : merged;
      streamRef.current = merged;
      if (videoRef.current) videoRef.current.srcObject = merged;
      onStream?.(merged); // push to WebRTC mesh

      const init = await api<{ recordingId: string }>(
        `/courses/${courseId}/sessions/${sessionId}/recordings`,
        { method: 'POST' },
      );
      recordingIdRef.current = init.recordingId;
      onRecordingIdChange?.(init.recordingId);
      partNumberRef.current = 1;
      partsRef.current = [];
      bufferRef.current = [];
      bufferBytesRef.current = 0;
      pendingFlushesRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
      const mr = new MediaRecorder(recordingStream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        // 192k Opus is well above transparency for speech and gives the
        // server transcode a cleaner source to work with. Some browsers drop
        // audio silently if no explicit bitrate is set.
        audioBitsPerSecond: 192_000,
      });
      mr.ondataavailable = (ev) => {
        if (ev.data.size === 0) return;
        bufferRef.current.push(ev.data);
        bufferBytesRef.current += ev.data.size;
        if (bufferBytesRef.current >= PART_MIN_BYTES) {
          pendingFlushesRef.current.push(flushPart(false).catch((e) => setError(e.message)));
        }
      };
      mr.start(5000);
      recorderRef.current = mr;

      screen.getVideoTracks()[0].onended = () => stop();

      setS('recording');
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (e: any) {
      setError(e.message ?? 'failed to start');
      setS('error');
      // If we already acquired screen/mic before the failure, release them
      // so the browser indicators don't stay lit.
      try {
        streamRef.current?.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      } catch {}
      streamRef.current = null;
      onStream?.(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      // Reset the guard so the user can retry.
      startGuardRef.current = false;
    }
  }

  useEffect(() => {
    if (autoStart && !startGuardRef.current) {
      startGuardRef.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    if (startSignal === lastStartSignalRef.current) return;
    lastStartSignalRef.current = startSignal;
    if (status === 'idle' || status === 'error' || status === 'done') {
      void start();
    }
  }, [startSignal, status]);

  useEffect(() => {
    if (stopSignal === lastStopSignalRef.current) return;
    lastStopSignalRef.current = stopSignal;
    if (status === 'recording') {
      void stop();
    }
  }, [stopSignal, status, stop]);

  useEffect(
    () => () => {
      // Hard-stop everything when the component unmounts (user navigated away
      // mid-recording, session ended, etc.) — the browser should never keep
      // mic/screen hardware active after this.
      try {
        recorderRef.current?.stop();
      } catch {}
      streamRef.current?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      existingMicStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      streamRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [existingMicStream],
  );

  function addChapter() {
    const label = chapterDraft.trim() || `Chapter ${chapters.length + 1}`;
    setChapters((cs) => [...cs, { timeSec: elapsed, label }]);
    setChapterDraft('');
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const live = status === 'recording';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {live && (
          <div className="animate-blink inline-flex items-center gap-1.5 bg-live-soft border border-live text-live px-2.5 py-0.5 rounded font-bold text-xs">
            ● RECORDING + LIVE
          </div>
        )}
        {(live || status === 'stopping' || status === 'uploading') && (
          <div className="font-mono text-lg tabular-nums">
            00 : {mm} : {ss}
          </div>
        )}
        {(status === 'uploading' || status === 'stopping') && (
          <div className="text-xs text-ink-mute ml-2">finalizing upload…</div>
        )}
      </div>

      <div className="aspect-video relative">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-contain"
        />
        {status === 'idle' && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-mute text-sm text-center px-6">
            Click <b className="text-ink mx-1">LIVE</b> in the floating
            control bar below to pick a screen and start the broadcast.
          </div>
        )}
      </div>

      {/* Start/Stop now lives in the floating ControlBar (LIVE / END buttons).
          This row keeps the chapter input + upload progress meter, which are
          still useful while recording. */}
      {(live || chapters.length > 0 || uploaded > 0) && (
        <div className="border border-ink rounded p-2.5 flex gap-2.5 items-center flex-wrap bg-paper-alt">
          {live && (
            <div className="flex items-center gap-2 flex-1">
              <input
                value={chapterDraft}
                onChange={(e) => setChapterDraft(e.target.value)}
                placeholder="chapter label (optional)"
                className="h-8 px-2 rounded text-sm border border-ink flex-1 min-w-[120px]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addChapter();
                  }
                }}
              />
              <button
                onClick={addChapter}
                className="h-8 px-3 rounded border border-ink/30 bg-paper text-sm hover:bg-paper-alt"
              >
                + Mark chapter
              </button>
            </div>
          )}
          <div className="font-mono text-xs text-ink-mute ml-auto">
            {uploaded > 0 && `⬆ ${(uploaded / 1024 / 1024).toFixed(1)} MB`}
          </div>
        </div>
      )}

      {chapters.length > 0 && (
        <div className="border border-ink rounded p-2.5 bg-paper">
          <div className="text-[10px] font-semibold text-ink-soft mb-1.5">
            CHAPTERS ({chapters.length})
          </div>
          <ul className="text-xs space-y-1">
            {chapters.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="font-mono text-ink-mute w-12">{fmtDuration(c.timeSec)}</span>
                <span className="flex-1">{c.label}</span>
                <button
                  onClick={() => setChapters((cs) => cs.filter((_, j) => j !== i))}
                  className="text-ink-mute hover:text-ink text-xs"
                  disabled={!live}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="bg-live-soft text-live border border-live rounded p-2.5 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
