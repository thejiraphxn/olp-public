'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useLiveRoom } from './useLiveRoom';
import { LivePanel, LivePanelTab } from './LivePanel';
import { ControlBar } from './ControlBar';
import { MeetingGrid } from './MeetingGrid';
import { UsersRail } from './UsersRail';
import { useToast } from '@/components/ui/Toast';
import { CourseRole } from '@/lib/enums';

/**
 * Fullscreen live-class viewer for students. Mirrors the teacher's record
 * page layout — main speaker tile + vertical users rail + slide-in side
 * panel + floating control bar — so students see exactly the same shell
 * the teacher does. Differences live in the control-bar buttons (raise
 * hand / leave stage instead of start/end live).
 */
export function StudentLive({
  courseId,
  sessionId,
  sessionTitle,
}: {
  courseId: string;
  sessionId: string;
  sessionTitle: string;
}) {
  const [state, actions] = useLiveRoom(sessionId, true, courseId);
  const toast = useToast();
  const [myStream, setMyStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(true); // start muted to satisfy autoplay policies
  // Local UI state mirrors track.enabled — keeps the button responsive even
  // before the room:updated echo arrives.
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [activePanel, setActivePanel] = useState<LivePanelTab | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const videoFrameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state.handAcceptedBy) return;
    if (myStream) return;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setMyStream(stream);
        actions.publish(stream);
        setMicOn(true);
        setCamOn(true);
        actions.setMedia({ isMicOn: true, isCamOn: true });
        toast.success("You're live — mic + camera on");
      } catch (e: any) {
        toast.error(e?.message ?? 'mic/camera permission denied');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.handAcceptedBy]);

  function toggleMic() {
    if (!myStream) return;
    const next = !micOn;
    for (const t of myStream.getAudioTracks()) t.enabled = next;
    setMicOn(next);
    actions.setMedia({ isMicOn: next });
  }

  function toggleCam() {
    if (!myStream) return;
    const next = !camOn;
    for (const t of myStream.getVideoTracks()) t.enabled = next;
    setCamOn(next);
    actions.setMedia({ isCamOn: next });
  }

  function leaveStage() {
    const goneId = myStream?.id;
    if (myStream) {
      myStream.getTracks().forEach((t) => t.stop());
      setMyStream(null);
    }
    actions.publish(null);
    if (goneId) actions.streamGone(goneId);
    actions.raiseHand(false);
    actions.setMedia({ isMicOn: false, isCamOn: false });
    setMicOn(true);
    setCamOn(true);
    toast.info('Left stage');
  }

  function togglePanel(t: LivePanelTab) {
    setActivePanel((cur) => (cur === t ? null : t));
  }

  // Native fullscreen on the main video frame. Browser handles ESC + the OS
  // chrome; we just keep local state in sync via the fullscreenchange event.
  function toggleFullscreen() {
    const el = videoFrameRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.().catch(() => {
        // Some browsers (older Safari) reject without user gesture or on
        // non-HTTPS — silently ignore; user can retry.
      });
    }
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const myself = state.participants.find((p) => p.socketId === state.mySocketId);
  const teacher = state.participants.find((p) => p.role === CourseRole.TEACHER);
  const studentCount = state.participants.filter((p) => p.role === CourseRole.STUDENT).length;
  const unansweredCount = state.questions.filter((q) => !q.answeredAt).length;
  const isOnStage = !!myStream;
  const handRaised = !!myself?.hasHandRaised;

  // Decide what fallback message to show if the main speaker tile is empty.
  const emptyMainState = !state.connected
    ? 'Connecting to classroom…'
    : state.error
      ? `Connection error: ${state.error}`
      : teacher
        ? "Waiting for the teacher's video to arrive…"
        : 'Waiting for the teacher to join the room…';

  // Click-to-unmute overlay — required because most browsers block audio
  // autoplay until the user has interacted with the page. Sits on top of
  // the main tile only; never covers the rails or control bar.
  const muteOverlay =
    muted && teacher ? (
      <button
        onClick={() => setMuted(false)}
        className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2 text-white hover:bg-black/60 transition-colors rounded-lg"
      >
        <div className="text-3xl">🔇</div>
        <div className="font-bold text-sm">Click to unmute</div>
        <div className="text-[11px] text-zinc-300">
          Browsers block autoplay with sound until you interact
        </div>
      </button>
    ) : null;

  return (
    <div className="h-dvh min-h-dvh flex flex-col bg-paper overflow-hidden">
      {/* Top bar — same shape as the teacher record page */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-ink/10">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link
            href={`/courses/${courseId}/sessions/${sessionId}`}
            className="font-mono text-[11px] text-ink-mute hover:underline shrink-0"
          >
            ← back
          </Link>
          <h1 className="text-base font-bold truncate">{sessionTitle}</h1>
          <div className="text-[11px] text-ink-soft flex gap-2 items-center shrink-0">
            <span className="text-live font-bold">● LIVE</span>
            <span>
              {studentCount} student{studentCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {/* Main area + side rails. Center column hosts the strict-16:9 main
          tile; nothing in this layout can overlap it because the rail and
          side panel are siblings, not stacked z-layers. */}
      <div className="relative flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-3 p-3 sm:p-4 overflow-y-auto pb-24 sm:pb-28">
          {/* 16:9 hero — width capped so the video stays a sensible size on
              ultrawide screens and the aspect ratio is preserved by the
              MeetingGrid → MainSpeakerTile chain (aspect-video + object-contain). */}
          {/* Native-fullscreen target. When `:fullscreen`, the wrapper fills
              the whole viewport — bg-black gives letterbox bars on non-16:9
              displays so the video keeps its aspect ratio. */}
          <div
            ref={videoFrameRef}
            className={[
              'w-full mx-auto relative',
              isFullscreen
                ? 'max-w-none bg-black flex items-center justify-center h-full'
                : 'max-w-5xl',
            ].join(' ')}
          >
            <div className={isFullscreen ? 'w-full max-w-[100vw]' : ''}>
              <MeetingGrid
                state={state}
                selfRole={CourseRole.STUDENT}
                selfName={myself?.name ?? 'You'}
                selfStream={myStream}
                selfMicOn={micOn && !!myStream}
                selfCamOn={camOn && !!myStream}
                showMainSpeaker
                hideSideTiles
                audioMuted={muted}
                mainOverlay={muteOverlay}
                emptyMainState={emptyMainState}
              />
            </div>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              className="absolute top-2 right-2 z-30 h-9 w-9 rounded-full bg-black/55 text-white text-base flex items-center justify-center hover:bg-black/75 transition-colors"
            >
              {isFullscreen ? '⤢' : '⛶'}
            </button>
          </div>
        </div>

        {/* Users rail — same component the teacher record page uses.
            Includes teacher's webcam (or screen-share thumbnail) so the
            student can see who's actively presenting. */}
        {state.connected && (
          <UsersRail
            state={state}
            actions={actions}
            myRole={CourseRole.STUDENT}
            selfStream={myStream}
            selfMicOn={micOn && !!myStream}
            selfCamOn={camOn && !!myStream}
          />
        )}

        {/* Side panel — slides in when a control-bar tab is active */}
        {activePanel && (
          <div className="absolute inset-0 z-20 bg-paper/80 backdrop-blur-[1px] md:static md:inset-auto md:z-0 md:shrink-0 md:bg-paper md:backdrop-blur-0 md:w-[360px] md:max-w-[42vw] md:border-l md:border-ink">
            <div className="h-full p-2 sm:p-3 pb-24 sm:pb-28">
              <LivePanel
                state={state}
                actions={actions}
                myRole={CourseRole.STUDENT}
                courseId={courseId}
                sessionId={sessionId}
                tab={activePanel}
                onTabChange={setActivePanel}
                onClose={() => setActivePanel(null)}
                showPeopleTab={false}
              />
            </div>
          </div>
        )}
      </div>

      {/* Floating control bar — student variant */}
      {state.connected && (
        <div className="pointer-events-none fixed inset-x-0 bottom-3 sm:bottom-4 z-40 flex justify-center px-3">
          <div className="pointer-events-auto max-w-full">
            <ControlBar
              studentMode
              studentHandRaised={handRaised}
              studentOnStage={isOnStage}
              onRaiseHand={() => actions.raiseHand(true)}
              onCancelHand={() => actions.raiseHand(false)}
              onLeaveStage={leaveStage}
              showMediaControls={isOnStage}
              micOn={micOn}
              micEnabled={isOnStage}
              onToggleMic={toggleMic}
              camOn={camOn}
              onToggleCam={toggleCam}
              activePanel={activePanel}
              onPanelToggle={togglePanel}
              chatUnread={state.chat.length}
              unansweredQuestions={unansweredCount}
            />
          </div>
        </div>
      )}
    </div>
  );
}
