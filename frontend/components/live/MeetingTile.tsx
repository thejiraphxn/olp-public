'use client';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { CourseRole } from '@/lib/enums';

export type MeetingTileProps = {
  /** A live MediaStream — null/undefined falls back to an avatar tile. */
  stream: MediaStream | null;
  name: string;
  role: CourseRole;
  /** Drives the bottom-left mic icon. */
  isMicOn?: boolean;
  /** When false (and stream has video), we still render avatar fallback because the publisher chose camera off. */
  isCamOn?: boolean;
  isSelf?: boolean;
  /** Mute the <video> tag (always true for self/secondary tiles to avoid echo). */
  audioMuted?: boolean;
  /** `contain` for screen share, `cover` for face cams. */
  fitMode?: 'cover' | 'contain';
  /** Visual size hint — drives avatar diameter and font sizes. */
  size?: 'main' | 'thumbnail';
  /** Optional suffix after the name (e.g. "· camera"). */
  label?: string;
  className?: string;
};

export function MeetingTile({
  stream,
  name,
  role,
  isMicOn = true,
  isCamOn = true,
  isSelf = false,
  audioMuted = false,
  fitMode = 'cover',
  size = 'thumbnail',
  label,
  className = '',
}: MeetingTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Track count is reactive: a remote MediaStream is mutated in place when
  // additional tracks arrive (each `pc.ontrack` fires one at a time). If we
  // computed `hasVideoTrack` only at render time, a tile that mounted with
  // an audio-only stream would never re-render to show the video track that
  // arrived a tick later — exactly the "student turned on camera but the
  // teacher still sees an avatar" bug.
  const [videoTrackCount, setVideoTrackCount] = useState(
    () => stream?.getVideoTracks().length ?? 0,
  );

  // Stable ref binding — avoids unnecessary srcObject reassignment that
  // would tear down the WebRTC track and cause flicker.
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Subscribe to the stream's track-list mutations so we re-render when a
  // late-arriving track flips the avatar→video state.
  useEffect(() => {
    if (!stream) {
      setVideoTrackCount(0);
      return;
    }
    const recompute = () => setVideoTrackCount(stream.getVideoTracks().length);
    recompute();
    stream.addEventListener('addtrack', recompute);
    stream.addEventListener('removetrack', recompute);
    return () => {
      stream.removeEventListener('addtrack', recompute);
      stream.removeEventListener('removetrack', recompute);
    };
  }, [stream]);

  const isTeacher = role === CourseRole.TEACHER;
  const hasVideoTrack = videoTrackCount > 0;
  // Render the <video> when we actually have a video track AND the publisher
  // hasn't toggled their camera off. For screen-share streams the publisher
  // doesn't have an isCamOn flag, so callers pass isCamOn=true explicitly.
  const showVideo = hasVideoTrack && isCamOn !== false;

  const avatarSize = size === 'main' ? 96 : 56;
  const nameSize = size === 'main' ? 'text-sm' : 'text-xs';

  return (
    <div
      className={[
        'relative bg-zinc-900 rounded-lg overflow-hidden border',
        isTeacher ? 'border-accent' : 'border-ink/40',
        className,
      ].join(' ')}
    >
      {/* Keep the <video> mounted at all times so srcObject stays bound and
          the browser auto-displays tracks the moment they're added — even
          if the avatar fallback was showing first. We only hide it when no
          video should be visible. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={audioMuted}
        className={[
          'absolute inset-0 w-full h-full',
          fitMode === 'contain' ? 'object-contain' : 'object-cover',
          showVideo ? '' : 'invisible',
        ].join(' ')}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-paper-alt">
          <div className="flex flex-col items-center gap-2">
            <Avatar name={name} size={avatarSize} />
            {isCamOn === false && (
              <div className="text-[10px] text-ink-mute font-mono">camera off</div>
            )}
          </div>
        </div>
      )}

      {/* Top-right: role + you badges */}
      <div className="absolute top-2 right-2 flex gap-1">
        {isTeacher && (
          <span className="bg-accent text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            TEACHER
          </span>
        )}
        {isSelf && (
          <span className="bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            YOU
          </span>
        )}
      </div>

      {/* Bottom-left: name + mic */}
      <div
        className={[
          'absolute bottom-2 left-2 flex items-center gap-1.5 bg-black/65 text-white px-2 py-1 rounded',
          nameSize,
        ].join(' ')}
      >
        <span
          className={isMicOn ? '' : 'opacity-60'}
          aria-label={isMicOn ? 'mic on' : 'mic off'}
        >
          {isMicOn ? '🎤' : '🔇'}
        </span>
        <span className="font-medium truncate max-w-[140px] sm:max-w-[200px]">
          {name}
          {label ? <span className="text-zinc-300 ml-1">{label}</span> : null}
        </span>
      </div>
    </div>
  );
}
