'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, setSessionCode, type Me } from '@/lib/api';
import { Recorder, type RecorderStatus } from '@/components/record/Recorder';
import { PreflightCheck } from '@/components/record/PreflightCheck';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useToast } from '@/components/ui/Toast';
import { useLiveRoom, type LiveRoomActions, type LiveRoomState } from '@/components/live/useLiveRoom';
import { LivePanel, LivePanelTab } from '@/components/live/LivePanel';
import { ControlBar } from '@/components/live/ControlBar';
import { UsersRail } from '@/components/live/UsersRail';
import { useMixedAudio } from '@/components/record/useMixedAudio';
import { CourseRole, RecordingStatus } from '@/lib/enums';

type Session = {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  // Teachers see the raw code; we use it to auto-stash sessionStorage so
  // the record-page socket can supply auth.sessionCode without a prompt.
  accessCode?: string | null;
  requiresAccessCode?: boolean;
  recording: null | { id: string; status: string; errorMessage?: string | null };
};

export default function RecordPage({ params }: { params: { courseId: string; sessionId: string } }) {
  const [session, setSession] = useState<Session | null>(null);
  // Drives the "🔗 Share" button — only PUBLIC courses get a shareable
  // session link (PRIVATE courses 403 anyone without an enrolment).
  const [courseVisibility, setCourseVisibility] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [passedPreflight, setPassedPreflight] = useState(false);
  const [preflightMicStream, setPreflightMicStream] = useState<MediaStream | null>(null);
  // Pre-acquired camera from PreflightCheck. Reused by openWebcam so the
  // user isn't prompted a second time when they toggle the camera on
  // during the live session. If they denied camera in preflight, this
  // stays null and openWebcam falls back to a fresh getUserMedia call.
  const [preflightCamStream, setPreflightCamStream] = useState<MediaStream | null>(null);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>('idle');
  // null = still checking; false = denied (will redirect); true = teacher
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const toast = useToast();
  const router = useRouter();

  // Hard role gate: only teachers may open this page. Non-teachers (students,
  // guests) get redirected to the session detail with an explanatory toast.
  // The backend enforces the same rule via requireCourseRole(['TEACHER']) on
  // every recording endpoint — this is the friendlier UX layer.
  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const me = await api<Me>('/auth/me');
        const m = me.memberships.find((x) => x.courseId === params.courseId);
        if (m?.role === CourseRole.TEACHER) {
          if (!canceled) setAuthorized(true);
          return;
        }
        if (canceled) return;
        toast.error('Only the course teacher can open the recording page.');
        router.replace(`/courses/${params.courseId}/sessions/${params.sessionId}`);
      } catch {
        if (canceled) return;
        toast.error('Sign in required.');
        router.replace('/login');
      }
    })();
    return () => {
      canceled = true;
    };
  }, [params.courseId, params.sessionId, router, toast]);

  const isLive = recorderStatus === 'recording';
  // Wait for the session row to load before opening the socket — otherwise
  // we race past `reload()` and the connectSocket() call reads sessionStorage
  // before we've stashed the access code, so room:join gets rejected.
  const [liveState, liveActions] = useLiveRoom(
    params.sessionId,
    !!session,
    params.courseId,
  );

  // Webcam (separate from the screen+mic pipeline that Recorder owns).
  // Added into the mesh as an à-la-carte track so students see the teacher's
  // face next to the screen share.
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const webcamTrackRef = useRef<MediaStreamTrack | null>(null);

  // The screen+mic stream the Recorder is publishing into the mesh. We keep
  // a handle so we can flip `track.enabled` for the mic-mute button below.
  // (Setting `enabled=false` is non-destructive — the track stays in the
  // peer connection, students just hear silence until we flip it back.)
  const [publishedStream, setPublishedStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);

  // Side panel — Meet-style. Single panel, one tab open at a time. Clicking
  // the same control-bar button while it's already showing closes it.
  const [activePanel, setActivePanel] = useState<LivePanelTab | null>(null);
  const [startLiveSignal, setStartLiveSignal] = useState(0);
  const [endLiveSignal, setEndLiveSignal] = useState(0);

  // Optional: bake accepted-on-stage participants' mics into the recording.
  // Off by default — flip on for Q&A. Mixer fades 50ms when toggled so we
  // don't click in the middle of speech.
  const [recordParticipants, setRecordParticipants] = useState(false);
  // Stable id signature → useMemo only invalidates when streams actually
  // join/leave (not on every parent render). Without this, useMixedAudio's
  // diff effect would re-run constantly, even though the hook is internally
  // idempotent it's wasteful and easier to reason about when stable.
  const remoteStreamsKey = (() => {
    const ids: string[] = [];
    for (const list of liveState.remoteStreams.values()) {
      for (const s of list) if (s.getAudioTracks().length > 0) ids.push(s.id);
    }
    return ids.sort().join(',');
  })();
  const remoteAudioStreams = useMemo(() => {
    const out: MediaStream[] = [];
    for (const list of liveState.remoteStreams.values()) {
      for (const s of list) {
        if (s.getAudioTracks().length > 0) out.push(s);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStreamsKey]);
  const mixedMicStream = useMixedAudio({
    baseStream: preflightMicStream,
    extraStreams: remoteAudioStreams,
    enabled: recordParticipants,
  });

  // Transcript drives the Track tab — populated once the recording is being
  // processed and Whisper writes segments back. Polled alongside status.
  const [transcript, setTranscript] = useState<
    { startSec: number; endSec: number; text: string }[] | null
  >(null);

  function toggleMic() {
    if (!publishedStream) return;
    const next = !micOn;
    for (const track of publishedStream.getAudioTracks()) {
      track.enabled = next;
    }
    setMicOn(next);
    liveActions.setMedia({ isMicOn: next });
  }

  function togglePanel(t: LivePanelTab) {
    setActivePanel((cur) => (cur === t ? null : t));
  }

  function toggleCam() {
    if (webcamStream) closeWebcam();
    else void openWebcam();
  }

  function startLiveFromBar() {
    setStartLiveSignal((n) => n + 1);
  }

  function endLiveFromBar() {
    setEndLiveSignal((n) => n + 1);
  }

  async function openWebcam() {
    try {
      // Reuse the camera acquired during preflight when its video track is
      // still live — avoids a second permission prompt and the latency of
      // getUserMedia warming the device.
      const preflightLive =
        preflightCamStream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
      const stream =
        preflightLive.length > 0
          ? preflightCamStream!
          : await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no video track from camera');
      // If the teacher disabled the camera in preflight, the track is
      // still live but `enabled=false`. Re-enable it so the mesh sees video.
      track.enabled = true;
      webcamTrackRef.current = track;
      setWebcamStream(stream);
      liveActions.addTrack(track, stream);
      liveActions.setMedia({ isCamOn: true });
      // Auto-stop the mesh track when the user kills the camera from the OS
      // (e.g. closing a webcam privacy shutter).
      track.onended = () => closeWebcam();
    } catch (e: any) {
      toast.error(e?.message ?? 'camera permission denied');
    }
  }

  function closeWebcam() {
    const track = webcamTrackRef.current;
    if (track) {
      liveActions.removeTrack(track);
      track.stop();
    }
    if (webcamStream) {
      for (const t of webcamStream.getTracks()) t.stop();
      liveActions.streamGone(webcamStream.id);
    }
    webcamTrackRef.current = null;
    setWebcamStream(null);
    liveActions.setMedia({ isCamOn: false });
  }

  // Clean up webcam when the page unmounts so the camera indicator drops.
  useEffect(() => {
    return () => {
      if (webcamTrackRef.current) {
        webcamTrackRef.current.stop();
        webcamTrackRef.current = null;
      }
    };
  }, []);

  // True the moment the recording flips into a post-live state — upload,
  // processing, or done. Computed early so the cleanup effect below can
  // depend on it. (The render-time `showProcessing` further down means the
  // same thing — kept in sync, just declared after the hooks must close.)
  const liveEnded =
    !!processingStatus ||
    session?.recording?.status === RecordingStatus.PROCESSING ||
    session?.recording?.status === RecordingStatus.READY;

  // After END live → make sure mic / camera / screen capture all stop so
  // the browser's "in use" indicators drop within seconds, not after the
  // upload finishes. The Recorder already stops the merged stream + the
  // preflight mic on stop(); we mop up the webcam + preflight cam here
  // since those aren't part of the recording pipeline.
  useEffect(() => {
    if (!liveEnded) return;
    if (webcamTrackRef.current) {
      try {
        webcamTrackRef.current.stop();
      } catch {}
      webcamTrackRef.current = null;
    }
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      setWebcamStream(null);
    }
    if (preflightCamStream) {
      preflightCamStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      setPreflightCamStream(null);
    }
    // Preflight mic — Recorder.stop() also stops this, but call again as
    // a belt-and-suspenders so a Recorder code path that skips it (e.g.
    // early error) doesn't leave the mic indicator lit.
    if (preflightMicStream) {
      preflightMicStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEnded]);

  async function reload() {
    try {
      const [s, course] = await Promise.all([
        api<Session>(`/courses/${params.courseId}/sessions/${params.sessionId}`),
        api<{ visibility?: string }>(`/courses/${params.courseId}`).catch(
          () => ({} as { visibility?: string }),
        ),
      ]);
      // Stash the access code BEFORE setSession — the latter triggers the
      // useLiveRoom effect (gated on !!session) which reads sessionStorage
      // on the very next render. Order matters or the socket opens with an
      // empty auth.sessionCode and gets rejected.
      if (s.accessCode) setSessionCode(s.id, s.accessCode);
      setSession(s);
      setCourseVisibility(course?.visibility ?? null);
      if (s.recording?.status === RecordingStatus.FAILED) {
        setProcessingStatus(RecordingStatus.FAILED);
        setRecordingId(s.recording.id);
      }
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load');
    }
  }
  useEffect(() => {
    reload();
  }, [params.courseId, params.sessionId]);

  useEffect(() => {
    if (!processingStatus) return;
    if (processingStatus === RecordingStatus.FAILED) return;
    const id = recordingId ?? session?.recording?.id;
    if (!id) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{
          status: string;
          transcript?: { startSec: number; endSec: number; text: string }[] | null;
        }>(
          `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${id}`,
        );
        setProcessingStatus(r.status);
        if (Array.isArray(r.transcript) && r.transcript.length > 0) {
          setTranscript(r.transcript);
        }
        if (r.status === RecordingStatus.READY) toast.success('Recording is ready 🎉');
        if (r.status === RecordingStatus.FAILED) toast.error('Processing failed');
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [processingStatus, recordingId, session?.recording?.id, params.courseId, params.sessionId, toast]);

  async function retry() {
    const id = recordingId ?? session?.recording?.id;
    if (!id) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${id}/retry`, {
        method: 'POST',
      });
      toast.info('Retrying…');
      setProcessingStatus(RecordingStatus.PROCESSING);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  if (authorized === null)
    return (
      <div className="p-6 text-ink-soft text-sm">Checking permissions…</div>
    );
  if (!authorized) return null; // already redirected
  if (!session) return null;
  const rec = session.recording;
  // If the previous attempt FAILED we treat it as "no recording yet" — the
  // init endpoint already resets the row, so the teacher can start fresh.
  const canStartFresh =
    !rec ||
    rec.status === RecordingStatus.PENDING ||
    rec.status === RecordingStatus.UPLOADING ||
    rec.status === RecordingStatus.FAILED;
  const showRecorder = passedPreflight && canStartFresh;
  const showProcessing =
    processingStatus ||
    rec?.status === RecordingStatus.PROCESSING ||
    rec?.status === RecordingStatus.READY;
  const showPreviousFailed = rec?.status === RecordingStatus.FAILED && !processingStatus;
  const canStartLive = showRecorder && ['idle', 'error', 'done'].includes(recorderStatus);
  const canEndLive = recorderStatus === 'recording';

  const studentCount = liveState.participants.filter(
    (p) => p.role === CourseRole.STUDENT,
  ).length;
  const unansweredCount = liveState.questions.filter((q) => !q.answeredAt).length;
  // Once the recording is being processed (uploading / transcoding /
  // ready), the live phase is over — hide the users rail + control bar
  // so the page collapses to a clean processing card.
  const useVerticalUsersRail = liveState.connected && !showProcessing;
  const showControlBar = liveState.connected && !showProcessing;

  return (
    <div className="h-dvh min-h-dvh flex flex-col bg-paper overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-ink/10">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link
            href={`/courses/${params.courseId}`}
            className="font-mono text-[11px] text-ink-mute hover:underline shrink-0"
          >
            ← back
          </Link>
          <h1 className="text-base font-bold truncate">{session.title}</h1>
          <div className="text-[11px] text-ink-soft flex gap-2 items-center shrink-0">
            {isLive && <span className="text-live font-bold">● LIVE</span>}
            <span>
              {studentCount} student{studentCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        {/* Share session link — public courses only. Same URL pattern as the
            playback page so anyone (guest or enrolled) lands on the right view
            depending on whether the session is currently LIVE or already ENDED. */}
        {courseVisibility === 'PUBLIC' && (
          <button
            onClick={() => {
              const url = `${window.location.origin}/courses/${params.courseId}/sessions/${params.sessionId}`;
              navigator.clipboard.writeText(url);
              toast.info('Copied session link');
            }}
            title="Copy public link to this session"
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded border border-ok bg-ok-soft text-ok hover:brightness-95"
          >
            🔗 Share
          </button>
        )}
      </div>

      {/* Main area + side panel */}
      <div className="relative flex-1 min-h-0 flex overflow-hidden">
        <div
          className={[
            'flex-1 min-w-0 min-h-0 flex flex-col gap-3 p-3 sm:p-4 overflow-y-auto',
            showControlBar ? 'pb-24 sm:pb-28' : '',
          ].join(' ')}
        >
          {showPreviousFailed && (
            <div className="border border-live bg-live-soft rounded p-3 text-sm">
              <div className="font-bold text-live">Previous attempt failed</div>
              <div className="text-ink-soft text-xs mt-1">
                {rec?.errorMessage ?? 'The earlier recording did not complete successfully.'}
                {' '}You can start a new recording below.
              </div>
            </div>
          )}

          {!passedPreflight && !showProcessing && (
            <PreflightCheck
              onReady={(micStream, camStream) => {
                setPreflightMicStream(micStream);
                setPreflightCamStream(camStream);
                setPassedPreflight(true);
              }}
            />
          )}

          {showRecorder && (
            <Recorder
              courseId={params.courseId}
              sessionId={params.sessionId}
              autoStart={false}
              startSignal={startLiveSignal}
              stopSignal={endLiveSignal}
              existingMicStream={preflightMicStream}
              recordingAudioStream={mixedMicStream}
              onRecordingIdChange={setRecordingId}
              onStatus={setRecorderStatus}
              onStream={(stream) => {
                setPublishedStream(stream);
                if (stream) {
                  setMicOn(stream.getAudioTracks().every((t) => t.enabled));
                }
                liveActions.publish(stream);
              }}
              onComplete={() => {
                setProcessingStatus(RecordingStatus.PROCESSING);
                reload();
              }}
            />
          )}

          {showProcessing && (
            <div className="border border-ink rounded p-4 bg-paper flex gap-4 items-center">
              {processingStatus !== RecordingStatus.READY && processingStatus !== RecordingStatus.FAILED && (
                <div
                  className="w-10 h-10 rounded-full border-[3px] border-warn border-t-transparent animate-spin-slow flex-shrink-0"
                  aria-hidden
                />
              )}
              <div className="flex-1">
                <div className="flex gap-2 items-center">
                  <span className="font-bold">
                    {processingStatus === RecordingStatus.READY
                      ? 'Recording ready 🎉'
                      : processingStatus === RecordingStatus.FAILED
                        ? 'Recording failed'
                        : 'Processing recording'}
                  </span>
                  <StatusPill
                    kind={
                      processingStatus === RecordingStatus.READY
                        ? 'ready'
                        : processingStatus === RecordingStatus.FAILED
                          ? 'failed'
                          : 'processing'
                    }
                  />
                </div>
                <div className="text-xs text-ink-soft">
                  {processingStatus === RecordingStatus.READY
                    ? 'Video is live. Transcript + summary generate in background.'
                    : processingStatus === RecordingStatus.FAILED
                      ? rec?.errorMessage ?? 'Encoder failed.'
                      : "Transcoding video (30 s – 2 min). Transcript runs after."}
                </div>
              </div>
              {processingStatus === RecordingStatus.READY && (
                <Link href={`/courses/${params.courseId}/sessions/${params.sessionId}`}>
                  <Button variant="primary">Open playback →</Button>
                </Link>
              )}
              {processingStatus === RecordingStatus.FAILED && (
                <Button variant="danger" onClick={retry}>
                  Retry
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Users rail — same component StudentLive uses. Includes the
            collapse toggle + Accept/Reject for raised hands (teacher only). */}
        {useVerticalUsersRail && (
          <UsersRail
            state={liveState}
            actions={liveActions}
            myRole={CourseRole.TEACHER}
            selfStream={webcamStream}
            selfMicOn={micOn}
            selfCamOn={!!webcamStream}
          />
        )}

        {/* Side panel — slides into view when a control-bar button is active */}
        {activePanel && (
          <div className="absolute inset-0 z-20 bg-paper/80 backdrop-blur-[1px] md:static md:inset-auto md:z-0 md:shrink-0 md:bg-paper md:backdrop-blur-0 md:w-[360px] md:max-w-[42vw] md:border-l md:border-ink">
            <div className="h-full p-2 sm:p-3 pb-24 sm:pb-28">
              <LivePanel
                state={liveState}
                actions={liveActions}
                myRole={CourseRole.TEACHER}
                courseId={params.courseId}
                sessionId={params.sessionId}
                tab={activePanel}
                onTabChange={setActivePanel}
                onClose={() => setActivePanel(null)}
                transcript={transcript}
                showPeopleTab={false}
              />
            </div>
          </div>
        )}
      </div>

      {/* Floating control bar — gated on `showControlBar` so it
          disappears the moment the recording flips into PROCESSING. */}
      {showControlBar && (
        <div className="pointer-events-none fixed inset-x-0 bottom-3 sm:bottom-4 z-40 flex justify-center px-3">
          <div className="pointer-events-auto max-w-full">
            <ControlBar
              canStartLive={canStartLive}
              canEndLive={canEndLive}
              onStartLive={startLiveFromBar}
              onEndLive={endLiveFromBar}
              showMediaControls={isLive}
              micOn={micOn}
              micEnabled={!!publishedStream}
              onToggleMic={toggleMic}
              camOn={!!webcamStream}
              onToggleCam={toggleCam}
              showRecordParticipants
              recordParticipants={recordParticipants}
              onToggleRecordParticipants={() => setRecordParticipants((v) => !v)}
              activePanel={activePanel}
              onPanelToggle={togglePanel}
              chatUnread={liveState.chat.length}
              unansweredQuestions={unansweredCount}
              trackEnabled={Array.isArray(transcript) && transcript.length > 0}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// UsersPresenceList moved into UsersRail.tsx (PresenceList) so teacher and
// student share the same shell; it now lives below the vertical MeetingGrid
// inside the rail.
