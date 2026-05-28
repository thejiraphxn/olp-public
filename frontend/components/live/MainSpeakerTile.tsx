'use client';
import type { ReactNode } from 'react';
import { MeetingTile, type MeetingTileProps } from './MeetingTile';

/**
 * Highlighted, full-width tile for the active speaker (typically the teacher's
 * screen share). Renders an `aspect-video` container so it doesn't grow
 * unbounded inside flex/grid parents, and forwards an `overlay` slot for
 * things like the click-to-unmute prompt that StudentLive shows on top of
 * the video before the user has interacted.
 */
export function MainSpeakerTile({
  overlay,
  ...tileProps
}: MeetingTileProps & { overlay?: ReactNode }) {
  return (
    <div className="relative aspect-video w-full">
      <MeetingTile
        {...tileProps}
        size="main"
        fitMode={tileProps.fitMode ?? 'contain'}
        className="absolute inset-0 w-full h-full"
      />
      {overlay}
    </div>
  );
}
