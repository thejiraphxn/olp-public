'use client';
import type { ReactNode } from 'react';
import { CourseRole } from '@/lib/enums';
import { MainSpeakerTile } from './MainSpeakerTile';
import { MeetingTile, type MeetingTileProps } from './MeetingTile';
import { pickPrimaryStream, pickSecondaryStream, type LiveRoomState } from './useLiveRoom';

type Props = {
  state: LiveRoomState;
  /** Role of the local user — drives self-tile badge color. */
  selfRole: CourseRole;
  selfName: string;
  /** Local stream to render in the self tile (student's combined a/v or teacher webcam). null if not publishing. */
  selfStream?: MediaStream | null;
  selfMicOn?: boolean;
  selfCamOn?: boolean;
  /**
   * Whether to render the highlighted main speaker tile (teacher screen share).
   * Students: true (they came to watch the teacher). Teachers: false (the
   * Recorder component already shows their own screen-capture preview).
   */
  showMainSpeaker?: boolean;
  /** Mute audio on the main tile until the user clicks unmute (autoplay policy). */
  audioMuted?: boolean;
  /** Overlay over main speaker tile — typically the click-to-unmute prompt. */
  mainOverlay?: ReactNode;
  /** Fallback when there's no main speaker stream yet. */
  emptyMainState?: ReactNode;
  /** Layout for participant tiles. */
  sideLayout?: 'grid' | 'vertical';
  /**
   * Hide all side tiles (the small participant grid that normally renders
   * below the main speaker). Used by StudentLive's main column where the
   * users rail on the right already shows everyone — the bottom strip is
   * redundant and competes with the 16:9 video for vertical space.
   */
  hideSideTiles?: boolean;
};

type SideTile = { key: string; props: MeetingTileProps };

/**
 * Google Meet–style layout. Pulls participant + stream + media-state data
 * straight from `useLiveRoom`'s state — no new sockets, no new WebRTC code.
 *
 * Layout rules:
 *   - Teacher's primary stream (screen+mic) → MainSpeakerTile if showMainSpeaker
 *   - Teacher's secondary stream (webcam) → side tile labeled "· camera"
 *   - Each remote participant with a primary stream → side tile (cam or avatar)
 *   - Local user (self) → side tile so they can self-monitor
 */
export function MeetingGrid({
  state,
  selfRole,
  selfName,
  selfStream = null,
  selfMicOn = true,
  selfCamOn = true,
  showMainSpeaker = true,
  audioMuted = false,
  mainOverlay,
  emptyMainState,
  sideLayout = 'grid',
  hideSideTiles = false,
}: Props) {
  const teacher = state.participants.find((p) => p.role === CourseRole.TEACHER);
  const teacherStreams = teacher ? state.remoteStreams.get(teacher.socketId) : undefined;
  const teacherPrimary = pickPrimaryStream(teacherStreams);
  const teacherSecondary = pickSecondaryStream(teacherStreams, teacherPrimary);

  // Decide who/what is the main speaker. Prefer screen+mic, fall back to webcam-only.
  const mainTileProps: MeetingTileProps | null =
    teacher && teacherPrimary
      ? {
          stream: teacherPrimary,
          name: teacher.name,
          role: teacher.role,
          isMicOn: teacher.isMicOn,
          isCamOn: true, // the primary stream IS the screen — always rendered
          audioMuted,
          fitMode: 'contain',
        }
      : teacher && teacherSecondary
        ? {
            stream: teacherSecondary,
            name: teacher.name,
            role: teacher.role,
            isMicOn: teacher.isMicOn,
            isCamOn: teacher.isCamOn,
            audioMuted,
            fitMode: 'cover',
          }
        : null;

  const teacherIsMainSpeaker = !!mainTileProps;

  const sideTiles: SideTile[] = [];

  for (const p of state.participants) {
    if (p.socketId === state.mySocketId) continue; // self handled at the end

    if (teacher && p.socketId === teacher.socketId) {
      // Teacher rendering rules differ depending on whether the main
      // speaker tile is also visible:
      //   showMainSpeaker=true  → main tile already has the screen-share,
      //                            so the rail only adds a webcam thumbnail
      //                            (or avatar if no streams) to avoid dup.
      //   showMainSpeaker=false → the rail is the only place the teacher
      //                            shows up, so always render their best
      //                            available stream (webcam > screen > avatar).
      if (showMainSpeaker) {
        if (teacherIsMainSpeaker && teacherPrimary && teacherSecondary) {
          sideTiles.push({
            key: `${teacher.socketId}-cam`,
            props: {
              stream: teacherSecondary,
              name: teacher.name,
              role: teacher.role,
              isMicOn: teacher.isMicOn,
              isCamOn: teacher.isCamOn,
              audioMuted: true,
              label: '· camera',
              fitMode: 'cover',
            },
          });
        } else if (!teacherIsMainSpeaker) {
          // Teacher in the room but no published video yet → avatar tile.
          sideTiles.push({
            key: teacher.socketId,
            props: {
              stream: null,
              name: teacher.name,
              role: teacher.role,
              isMicOn: teacher.isMicOn,
              isCamOn: teacher.isCamOn,
              audioMuted: false,
              fitMode: 'cover',
            },
          });
        }
      } else {
        // Rail-only mode (teacher record page, student users rail).
        // Pick the best stream so the teacher always appears.
        const stream = teacherSecondary ?? teacherPrimary ?? null;
        const isWebcam = stream === teacherSecondary && !!teacherSecondary;
        sideTiles.push({
          key: teacher.socketId,
          props: {
            stream,
            name: teacher.name,
            role: teacher.role,
            isMicOn: teacher.isMicOn,
            isCamOn: teacher.isCamOn,
            // Mute the duplicate audio track when both screen+cam exist —
            // the main tile (or another listener) already plays the mic.
            audioMuted: true,
            label: isWebcam ? '· camera' : stream ? '· screen' : undefined,
            fitMode: isWebcam ? 'cover' : 'contain',
          },
        });
      }
      continue;
    }

    // Regular remote participant (student).
    const stream = pickPrimaryStream(state.remoteStreams.get(p.socketId));
    sideTiles.push({
      key: p.socketId,
      props: {
        stream,
        name: p.name,
        role: p.role,
        isMicOn: p.isMicOn,
        isCamOn: p.isCamOn,
        audioMuted: false,
        fitMode: 'cover',
      },
    });
  }

  // Self tile last so the user's own face sits at the end of the strip.
  sideTiles.push({
    key: 'self',
    props: {
      stream: selfStream,
      name: selfName,
      role: selfRole,
      isMicOn: selfMicOn,
      isCamOn: selfCamOn,
      isSelf: true,
      audioMuted: true, // never play your own mic back into the room
      fitMode: 'cover',
    },
  });

  return (
    <div
      className={[
        'flex flex-col gap-3',
        sideLayout === 'vertical' ? 'w-full sm:w-[240px]' : '',
      ].join(' ')}
    >
      {showMainSpeaker &&
        (mainTileProps ? (
          <MainSpeakerTile {...mainTileProps} overlay={mainOverlay} />
        ) : (
          <div className="aspect-video bg-zinc-900 rounded-lg border border-ink/40 flex items-center justify-center text-zinc-300 text-sm text-center px-4">
            {emptyMainState ?? "Waiting for the teacher's video to arrive…"}
          </div>
        ))}

      {!hideSideTiles && sideTiles.length > 0 && (
        <div
          className={
            sideLayout === 'vertical'
              ? 'flex flex-col gap-2'
              : 'grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
          }
        >
          {sideTiles.map(({ key, props }) => (
            <div
              key={key}
              className={
                sideLayout === 'vertical'
                  ? 'h-[124px]'
                  : 'aspect-video'
              }
            >
              <MeetingTile {...props} className="w-full h-full" size="thumbnail" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
