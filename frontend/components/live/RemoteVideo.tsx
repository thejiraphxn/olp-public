'use client';
import { useEffect, useRef } from 'react';

export function RemoteVideo({
  stream,
  muted,
  label,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className={`relative bg-black rounded overflow-hidden ${className ?? ''}`}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className="w-full h-full object-contain"
      />
      {label && (
        <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
          {label}
        </div>
      )}
    </div>
  );
}
