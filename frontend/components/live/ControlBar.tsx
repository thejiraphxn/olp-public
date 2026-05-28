'use client';
/**
 * Meeting-style control bar (Google Meet / Microsoft Teams pattern).
 *
 * Lives at the bottom of the live/record screen and consolidates every
 * action that used to be sprinkled through the page:
 *   - mic on/off
 *   - camera on/off
 *   - chat / Q&A side-panel toggles (single panel, one tab open
 *     at a time — clicking the same button again closes it)
 *
 * Stateless. Parent owns the booleans + handlers.
 */
import type { LivePanelTab } from './LivePanel';

type Props = {
  // Live lifecycle controls (teacher only — start/end the broadcast)
  canStartLive?: boolean;
  canEndLive?: boolean;
  onStartLive?: () => void;
  onEndLive?: () => void;

  // Student-side stage controls. Mutually exclusive with teacher's
  // start/end — when `studentMode` is on, the LIVE button is replaced
  // with a context-aware Raise hand / Cancel / Leave-stage button.
  studentMode?: boolean;
  studentHandRaised?: boolean;
  studentOnStage?: boolean;
  onRaiseHand?: () => void;
  onCancelHand?: () => void;
  onLeaveStage?: () => void;

  // Mic + camera — rendered when `showMediaControls` is true
  // (teacher: recording started; student: invited on stage).
  showMediaControls: boolean;
  micOn: boolean;
  micEnabled: boolean; // false when no published stream yet (button disabled)
  onToggleMic: () => void;
  camOn: boolean;
  onToggleCam: () => void;

  // Teacher-only: include accepted-on-stage participants' mics in the
  // recording. Off by default — flip on when the teacher wants Q&A audio
  // baked into the mp4 alongside their own narration. Hidden in student
  // mode and when media controls aren't visible.
  showRecordParticipants?: boolean;
  recordParticipants?: boolean;
  onToggleRecordParticipants?: () => void;

  // Side panel
  activePanel: LivePanelTab | null;
  onPanelToggle: (t: LivePanelTab) => void;

  // Counts (badges)
  chatUnread?: number;
  unansweredQuestions?: number;
  // Track button — only shown when a transcript is available (post-recording).
  // When `null`/`undefined` the button is omitted entirely.
  trackEnabled?: boolean;
};

export function ControlBar({
  canStartLive = false,
  canEndLive = false,
  onStartLive,
  onEndLive,
  studentMode = false,
  studentHandRaised = false,
  studentOnStage = false,
  onRaiseHand,
  onCancelHand,
  onLeaveStage,
  showMediaControls,
  micOn,
  micEnabled,
  onToggleMic,
  camOn,
  onToggleCam,
  showRecordParticipants = false,
  recordParticipants = false,
  onToggleRecordParticipants,
  activePanel,
  onPanelToggle,
  chatUnread = 0,
  unansweredQuestions = 0,
  trackEnabled = false,
}: Props) {
  // The leftmost lifecycle button morphs by role + state:
  //   teacher:  LIVE  →  END
  //   student:  HAND  →  CANCEL  →  LEAVE  (and back to HAND when off-stage)
  const lifecycleButton = studentMode ? (
    studentOnStage ? (
      <RoundButton
        active={false}
        danger
        disabled={!onLeaveStage}
        onClick={onLeaveStage ?? (() => {})}
        label="Leave stage"
      >
        <span className="text-sm font-bold">LEAVE</span>
      </RoundButton>
    ) : studentHandRaised ? (
      <RoundButton
        active
        disabled={!onCancelHand}
        onClick={onCancelHand ?? (() => {})}
        label="Cancel raised hand"
      >
        <span className="text-base">✋</span>
      </RoundButton>
    ) : (
      <RoundButton
        active={false}
        disabled={!onRaiseHand}
        onClick={onRaiseHand ?? (() => {})}
        label="Raise hand"
      >
        <span className="text-base">✋</span>
      </RoundButton>
    )
  ) : canEndLive ? (
    <RoundButton
      active={false}
      danger
      disabled={!onEndLive}
      onClick={onEndLive ?? (() => {})}
      label="End live"
    >
      <span className="text-sm font-bold">END</span>
    </RoundButton>
  ) : (
    <RoundButton
      active={false}
      danger={false}
      disabled={!canStartLive || !onStartLive}
      onClick={onStartLive ?? (() => {})}
      label="Start live"
    >
      <span className="text-sm font-bold">LIVE</span>
    </RoundButton>
  );

  return (
    <div className="w-full overflow-x-auto pb-1">
      <div className="flex items-center justify-center gap-2 px-3 py-2 bg-paper-alt border border-ink rounded-full shadow-sm w-max mx-auto">
        {lifecycleButton}

        <Divider />

        {showMediaControls && (
          <>
            <RoundButton
              active={!micOn}
              danger={!micOn}
              disabled={!micEnabled}
              onClick={onToggleMic}
              label={micOn ? 'Mute mic' : 'Unmute mic'}
            >
              <span className="text-base">{micOn ? '🎙' : '🔇'}</span>
            </RoundButton>

            <RoundButton
              active={!camOn}
              danger={!camOn}
              onClick={onToggleCam}
              label={camOn ? 'Turn camera off' : 'Turn camera on'}
            >
              <span className="text-base">{camOn ? '📹' : '📷'}</span>
            </RoundButton>

            {showRecordParticipants && (
              <RoundButton
                active={recordParticipants}
                onClick={onToggleRecordParticipants ?? (() => {})}
                disabled={!onToggleRecordParticipants}
                label={
                  recordParticipants
                    ? 'Stop including participant audio in the recording'
                    : 'Include participant audio in the recording (Q&A mode)'
                }
              >
                <span className="text-base">{recordParticipants ? '🎙' : '👥'}</span>
              </RoundButton>
            )}

            <Divider />
          </>
        )}

        {/* Panel toggles */}
        <RoundButton
          active={activePanel === 'chat'}
          onClick={() => onPanelToggle('chat' as LivePanelTab)}
          label="Chat"
          badge={chatUnread > 0 ? chatUnread : undefined}
        >
          <span className="text-base">💬</span>
        </RoundButton>

        <RoundButton
          active={activePanel === 'questions'}
          onClick={() => onPanelToggle('questions' as LivePanelTab)}
          label="Questions"
          badge={unansweredQuestions > 0 ? unansweredQuestions : undefined}
          badgeColor="warn"
        >
          <span className="text-base">❓</span>
        </RoundButton>

        {trackEnabled && (
          <RoundButton
            active={activePanel === 'track'}
            onClick={() => onPanelToggle('track' as LivePanelTab)}
            label="Track (transcript + note)"
          >
            <span className="text-base">📝</span>
          </RoundButton>
        )}
      </div>
    </div>
  );
}

function RoundButton({
  children,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  label,
  badge,
  badgeColor = 'accent',
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  badge?: string | number;
  badgeColor?: 'accent' | 'warn' | 'live' | 'mute';
}) {
  const base =
    'relative w-11 h-11 rounded-full flex items-center justify-center border transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const colors = danger
    ? 'bg-live text-white border-live hover:brightness-110'
    : active
      ? 'bg-accent text-white border-accent hover:brightness-110'
      : 'bg-paper text-ink border-ink/30 hover:bg-paper';
  const badgeBg: Record<string, string> = {
    accent: 'bg-accent text-white',
    warn: 'bg-warn text-white',
    live: 'bg-live text-white',
    mute: 'bg-paper-alt text-ink-soft border border-ink/30',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={[base, colors].join(' ')}
    >
      {children}
      {badge !== undefined && (
        <span
          className={[
            'absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center',
            badgeBg[badgeColor],
          ].join(' ')}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-6 bg-ink/15 mx-1" />;
}
