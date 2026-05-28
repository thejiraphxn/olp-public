'use client';
import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { CourseRole } from '@/lib/enums';
import { MeetingGrid } from './MeetingGrid';
import type { LiveRoomActions, LiveRoomState } from './useLiveRoom';

/**
 * Shared right-rail used by both teacher's record page and StudentLive.
 *
 * Always shows:
 *   - vertical MeetingGrid (every participant; teacher's webcam or screen
 *     share is included since `showMainSpeaker={false}` is passed)
 *   - a `›` collapse toggle so the rail can shrink to a 60px strip
 *
 * Teacher-only extras (`myRole === TEACHER`):
 *   - a presence list with Accept / Reject buttons for raised hands
 */
export function UsersRail({
  state,
  actions,
  myRole,
  selfStream,
  selfMicOn,
  selfCamOn,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
  selfStream: MediaStream | null;
  selfMicOn: boolean;
  selfCamOn: boolean;
}) {
  const [open, setOpen] = useState(true);
  const myself = state.participants.find((p) => p.socketId === state.mySocketId);
  const selfName = myself?.name ?? 'You';

  return (
    <div
      className={[
        'hidden md:flex border-l border-ink shrink-0 bg-paper min-h-0',
        open ? 'md:w-[280px] lg:w-[320px]' : 'md:w-[60px]',
      ].join(' ')}
    >
      <div className="h-full w-full p-3 flex flex-col min-h-0 gap-2">
        <div className="flex items-center justify-between gap-2">
          {open && (
            <div className="text-[11px] font-semibold text-ink-soft">
              USERS ({state.participants.length})
            </div>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            title={open ? 'Hide users' : 'Show users'}
            aria-label={open ? 'Hide users' : 'Show users'}
            className="h-7 w-7 rounded border border-ink/30 bg-paper-alt text-[11px] font-semibold hover:bg-paper flex items-center justify-center ml-auto shrink-0"
          >
            {open ? '›' : '‹'}
          </button>
        </div>

        {open && (
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
            <MeetingGrid
              state={state}
              selfRole={myRole}
              selfName={selfName}
              selfStream={selfStream}
              selfMicOn={selfMicOn}
              selfCamOn={selfCamOn}
              showMainSpeaker={false}
              sideLayout="vertical"
            />
            {myRole === CourseRole.TEACHER && (
              <PresenceList state={state} actions={actions} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact presence list with Accept/Reject buttons for students who have
 * raised their hand. Teacher-only — gates the action buttons via myRole.
 * Pulled out of record/page.tsx so the rail owns it now.
 */
function PresenceList({
  state,
  actions,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
}) {
  const raised = state.participants.filter(
    (p) => p.role === CourseRole.STUDENT && p.hasHandRaised,
  );
  if (raised.length === 0) return null;
  return (
    <div className="border border-warn/40 bg-warn-soft/30 rounded p-2">
      <div className="text-[10px] font-mono text-warn font-bold mb-1.5">
        ✋ Raised hands ({raised.length})
      </div>
      <div className="flex flex-col gap-1.5">
        {raised.map((p) => (
          <div
            key={p.socketId}
            className="rounded border border-ink/20 bg-paper px-2 py-1.5 flex items-center gap-2"
          >
            <Avatar name={p.name} size={20} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold truncate">{p.name}</div>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button
                variant="primary"
                size="sm"
                onClick={() => actions.acceptHand(p.socketId)}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.rejectHand(p.socketId)}
              >
                Reject
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
