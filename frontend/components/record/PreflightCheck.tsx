'use client';
import { useEffect, useRef, useState } from 'react';

type Check = { label: string; state: 'ok' | 'warn' | 'unknown'; detail?: string };

export function PreflightCheck({
  onReady,
}: {
  /**
   * Hand the live mic + camera streams to the caller. Either may be null
   * if the user denied that specific permission — the recorder will
   * fall back gracefully (mic re-prompt, no webcam tile).
   */
  onReady: (
    micStream: MediaStream | null,
    camStream: MediaStream | null,
  ) => void;
}) {
  const [mic, setMic] = useState<Check>({ label: 'Microphone', state: 'unknown' });
  const [cam, setCam] = useState<Check>({ label: 'Camera', state: 'unknown' });
  const [display, setDisplay] = useState<Check>({ label: 'Screen capture', state: 'unknown' });
  const [mediaRec, setMediaRec] = useState<Check>({
    label: 'MediaRecorder / WebM support',
    state: 'unknown',
  });
  const [micLevel, setMicLevel] = useState(0);
  // Local UI state for the toggle buttons. Mirrors the underlying track's
  // `enabled` flag so the buttons are responsive even before MediaRecorder
  // is started.
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const micStreamRef = useRef<MediaStream | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const hasDisplay = !!navigator.mediaDevices?.getDisplayMedia;
    setDisplay({
      label: 'Screen capture',
      state: hasDisplay ? 'ok' : 'warn',
      detail: hasDisplay ? 'supported' : 'browser does not support getDisplayMedia',
    });
    const hasMR =
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus');
    setMediaRec({
      label: 'MediaRecorder / WebM support',
      state: hasMR ? 'ok' : 'warn',
      detail: hasMR
        ? 'vp8 + opus (Video + Audio Codec)'
        : 'webm/vp8/opus not supported — try Chrome',
    });

    let cancelled = false;
    (async () => {
      // Request mic + cam separately so a single denied permission doesn't
      // wipe out the other. Browsers show the prompts back-to-back; users
      // can click "Allow" or "Block" on each.
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          audioStream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = audioStream;
        const label = audioStream.getAudioTracks()[0]?.label ?? 'default mic';
        setMic({ label: 'Microphone', state: 'ok', detail: label });

        // VU meter
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(audioStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += (v - 128) ** 2;
          const rms = Math.sqrt(sum / data.length) / 128;
          setMicLevel(Math.min(1, rms * 3));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e: any) {
        setMic({
          label: 'Microphone',
          state: 'warn',
          detail: e?.message ?? 'permission denied',
        });
      }

      if (cancelled) return;

      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          videoStream.getTracks().forEach((t) => t.stop());
          return;
        }
        camStreamRef.current = videoStream;
        const label = videoStream.getVideoTracks()[0]?.label ?? 'default camera';
        setCam({ label: 'Camera', state: 'ok', detail: label });
        // Don't assign srcObject here — the <video> element is conditionally
        // rendered, so it's not mounted yet. The callback ref below picks
        // up the stream the moment the element mounts.
      } catch (e: any) {
        // Camera is OPTIONAL — proceeding without it is fine.
        setCam({
          label: 'Camera',
          state: 'warn',
          detail: e?.message ?? 'permission denied (camera optional)',
        });
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Close the VU-meter AudioContext — without this it can hold a
      // reference to the mic stream and keep the indicator on even after
      // the tracks have been stopped.
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      // NOTE: don't stop the mic/cam tracks here — the Recorder + webcam
      // toggle inherit them. Tracks get stopped when Recorder.stop() runs.
    };
  }, []);

  function toggleMic() {
    const s = micStreamRef.current;
    if (!s) return;
    const next = !micOn;
    for (const t of s.getAudioTracks()) t.enabled = next;
    setMicOn(next);
  }

  function toggleCam() {
    const s = camStreamRef.current;
    if (!s) return;
    const next = !camOn;
    for (const t of s.getVideoTracks()) t.enabled = next;
    setCamOn(next);
  }

  // Mic is required to proceed; camera is optional (warn is fine).
  const allOk = mic.state === 'ok' && display.state === 'ok';

  return (
    <div className="border border-ink rounded p-4 flex flex-col gap-4">
      <div>
        <div className="text-[11px] font-semibold text-ink-soft mb-2">PRE-FLIGHT CHECK</div>
        <ul className="flex flex-col gap-1.5">
          {[mic, cam].map((c) => (
            <li key={c.label} className="flex items-center gap-2.5 text-sm">
              <span
                className={[
                  'w-7 h-7 rounded-full flex items-center justify-center font-bold text-base leading-none',
                  c.state === 'ok'
                    ? 'bg-ok-soft text-ok border border-ok'
                    : c.state === 'warn'
                      ? 'bg-warn-soft text-warn border border-warn'
                      : 'bg-paper-alt text-ink-mute border border-ink-mute/40',
                ].join(' ')}
              >
                {c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '…'}
              </span>
              <span className="font-semibold">{c.label}</span>
              {c.detail && (
                <span className="text-xs text-ink-soft font-mono truncate">— {c.detail}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Camera preview — only shown when the cam permission resolved. */}
      <div className="grid gap-3 md:grid-cols-[260px_1fr] items-start">
        <div className="aspect-video bg-black rounded overflow-hidden relative border border-ink/30">
          {cam.state === 'ok' ? (
            <video
              ref={(el) => {
                videoRef.current = el;
                // Callback ref fires the moment the <video> is mounted
                // (after cam.state flips to 'ok' and React re-renders).
                // By this time camStreamRef is already set, so bind here.
                if (el && camStreamRef.current && el.srcObject !== camStreamRef.current) {
                  el.srcObject = camStreamRef.current;
                }
              }}
              autoPlay
              muted
              playsInline
              className={[
                'w-full h-full object-cover',
                camOn ? '' : 'invisible',
              ].join(' ')}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-xs text-center px-3">
              {cam.state === 'warn'
                ? 'Camera unavailable — you can still record without one.'
                : 'Waiting for camera permission…'}
            </div>
          )}
          {cam.state === 'ok' && !camOn && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-300 text-xs font-mono">
              camera off
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[11px] text-ink-soft font-semibold mb-1">MIC LEVEL</div>
            <div className="h-2 bg-paper-alt border border-ink-mute/40 rounded overflow-hidden">
              <div
                className={
                  micLevel > 0.75 ? 'h-full bg-live' : 'h-full bg-ok transition-[width]'
                }
                style={{ width: `${Math.round(micOn ? micLevel * 100 : 0)}%` }}
              />
            </div>
            <div className="text-[10px] font-mono text-ink-mute mt-1">
              {mic.state === 'ok'
                ? micOn
                  ? 'Say something to verify you can be heard.'
                  : 'Mic is muted — unmute to test.'
                : '—'}
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={toggleMic}
              disabled={mic.state !== 'ok'}
              title={micOn ? 'Mute mic' : 'Unmute mic'}
              className={[
                'h-9 px-3 rounded border text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed',
                micOn
                  ? 'border-accent bg-accent text-white'
                  : 'border-ink/30 bg-paper-alt text-ink-soft',
              ].join(' ')}
            >
              {micOn ? '🎙 Mic on' : '🔇 Mic off'}
            </button>
            <button
              onClick={toggleCam}
              disabled={cam.state !== 'ok'}
              title={camOn ? 'Turn camera off' : 'Turn camera on'}
              className={[
                'h-9 px-3 rounded border text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed',
                camOn
                  ? 'border-accent bg-accent text-white'
                  : 'border-ink/30 bg-paper-alt text-ink-soft',
              ].join(' ')}
            >
              {camOn ? '📹 Camera on' : '📷 Camera off'}
            </button>
          </div>

          <div className="text-[11px] text-ink-mute">
            These choices carry into the live session — start with the mic
            muted or camera off here and the recording will too. Toggle
            mid-session from the control bar at any time.
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => {
            // Stop the VU-meter loop but keep the mic/cam tracks alive — hand
            // them off to the recorder so the user isn't re-prompted.
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            onReady(micStreamRef.current, camStreamRef.current);
          }}
          disabled={!allOk}
          className="h-10 px-4 rounded border border-live bg-live text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ● Continue
        </button>
      </div>
    </div>
  );
}
