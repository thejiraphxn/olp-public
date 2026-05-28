'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Web Audio mixer that combines the teacher's own mic with the live
 * audio tracks of every accepted-on-stage participant. Outputs a single
 * stable MediaStream whose audio track stays alive across input changes
 * — safe to feed to MediaRecorder for the duration of the session.
 *
 * Behaviour:
 *   - `baseStream` is always live (gain=1). Typically the teacher's mic.
 *   - `extraStreams` contributors are gated by `enabled`. When false,
 *     each extra source's gain drops to 0 (still connected, just silent).
 *     This avoids tearing down/rebuilding nodes mid-recording.
 *   - When `extraStreams` changes (student joins/leaves stage), the hook
 *     diffs by stream id and adds/removes nodes — the destination
 *     MediaStream itself never gets replaced.
 *
 * Returns null until baseStream is supplied (preflight not done yet).
 */
export function useMixedAudio({
  baseStream,
  extraStreams,
  enabled,
}: {
  baseStream: MediaStream | null;
  extraStreams: MediaStream[];
  enabled: boolean;
}): MediaStream | null {
  const [outputStream, setOutputStream] = useState<MediaStream | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const baseNodeRef = useRef<{
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    streamId: string;
  } | null>(null);
  // Per-extra source map keyed by stream id so we can diff cheaply.
  const extraNodesRef = useRef<
    Map<
      string,
      { source: MediaStreamAudioSourceNode; gain: GainNode; stream: MediaStream }
    >
  >(new Map());

  // Try to resume the AudioContext. Browsers reject `resume()` outside a
  // user gesture, but many will queue it for the next click — so it's
  // safe to call defensively. Without this, the context stays in
  // `suspended` and the MediaStreamDestination produces silence (which
  // is exactly the "recording has no audio" symptom we hit).
  function tryResume() {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        /* will retry on next gesture via the document listener below */
      });
    }
  }

  // (1) Lazy-init AudioContext + destination when baseStream first arrives.
  useEffect(() => {
    if (!baseStream) return;
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        // Safari still ships webkitAudioContext on some versions.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
      ctxRef.current = new Ctor();
      destRef.current = ctxRef.current.createMediaStreamDestination();
      setOutputStream(destRef.current.stream);
      tryResume();
    }
  }, [baseStream]);

  // Backup: any user gesture on the page tries to resume. Once running,
  // the listener removes itself. Catches the case where preflight set
  // baseStream long before the user clicked LIVE — by then the context
  // is suspended and silent until something wakes it.
  useEffect(() => {
    const onAnyGesture = () => {
      tryResume();
      if (ctxRef.current?.state === 'running') {
        document.removeEventListener('pointerdown', onAnyGesture);
        document.removeEventListener('keydown', onAnyGesture);
      }
    };
    document.addEventListener('pointerdown', onAnyGesture);
    document.addEventListener('keydown', onAnyGesture);
    return () => {
      document.removeEventListener('pointerdown', onAnyGesture);
      document.removeEventListener('keydown', onAnyGesture);
    };
  }, []);

  // (2) Wire baseStream → destination. Recreate when the stream object
  //     changes (e.g. teacher swaps mics).
  useEffect(() => {
    const ctx = ctxRef.current;
    const dest = destRef.current;
    if (!ctx || !dest || !baseStream) return;
    if (baseStream.getAudioTracks().length === 0) return;
    if (baseNodeRef.current && baseNodeRef.current.streamId === baseStream.id) {
      return; // already wired
    }
    // Tear down old base node if present
    baseNodeRef.current?.source.disconnect();
    baseNodeRef.current?.gain.disconnect();

    const source = ctx.createMediaStreamSource(baseStream);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(dest);
    baseNodeRef.current = { source, gain, streamId: baseStream.id };
    tryResume();
  }, [baseStream]);

  // Track latest `enabled` in a ref so effect (3) can read it without
  // depending on it. We don't want toggling to retrigger the diff effect —
  // it would iterate sources for nothing and (in some browsers) brief
  // audio glitches surface in the published WebRTC track.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // (3) Diff extraStreams. Add new ones, drop missing. Initial gain on
  // a new source uses the current `enabled` (read via ref). Existing
  // sources' gains are flipped by effect (4) — toggling does NOT re-run
  // this effect.
  useEffect(() => {
    const ctx = ctxRef.current;
    const dest = destRef.current;
    if (!ctx || !dest) return;

    const incoming = new Map<string, MediaStream>();
    for (const s of extraStreams) {
      if (s.getAudioTracks().length > 0) incoming.set(s.id, s);
    }

    // Remove gone
    for (const [id, node] of extraNodesRef.current) {
      if (!incoming.has(id)) {
        node.source.disconnect();
        node.gain.disconnect();
        extraNodesRef.current.delete(id);
      }
    }

    // Add new
    for (const [id, stream] of incoming) {
      if (extraNodesRef.current.has(id)) continue;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = enabledRef.current ? 1 : 0;
        source.connect(gain).connect(dest);
        extraNodesRef.current.set(id, { source, gain, stream });
      } catch {
        // createMediaStreamSource throws if the stream has zero audio
        // tracks even though we filtered above; silently skip.
      }
    }
  }, [extraStreams]);

  // (4) Toggle gain on existing extras when `enabled` flips.
  useEffect(() => {
    tryResume();
    const ctx = ctxRef.current;
    if (!ctx) return;
    const targetGain = enabled ? 1 : 0;
    const t = ctx.currentTime;
    for (const node of extraNodesRef.current.values()) {
      // setTargetAtTime gives a 50ms ramp — avoids audible clicks when
      // the teacher toggles the button mid-sentence.
      node.gain.gain.setTargetAtTime(targetGain, t, 0.05);
    }
  }, [enabled]);

  // (5) Cleanup on unmount — close the context so the audio worklet
  //     thread can shut down. React Strict Mode safe (re-init on remount).
  useEffect(() => {
    return () => {
      for (const node of extraNodesRef.current.values()) {
        node.source.disconnect();
        node.gain.disconnect();
      }
      extraNodesRef.current.clear();
      baseNodeRef.current?.source.disconnect();
      baseNodeRef.current?.gain.disconnect();
      baseNodeRef.current = null;
      void ctxRef.current?.close();
      ctxRef.current = null;
      destRef.current = null;
    };
  }, []);

  return outputStream;
}
