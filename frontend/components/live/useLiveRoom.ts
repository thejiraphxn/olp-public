'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket, type OLPSocket } from '@/lib/socket';
import { RTCMesh } from '@/lib/rtc';
import { api } from '@/lib/api';
import type { ChatAttachment, ChatMessage, Participant, Question } from '@/lib/live-types';

export type LiveRoomState = {
  connected: boolean;
  error: string | null;
  mySocketId: string | undefined;
  participants: Participant[];
  chat: ChatMessage[];
  questions: Question[];
  // Multiple streams per peer: teacher publishes screen+mic AND (optionally)
  // a separate webcam stream. Use pickPrimaryStream/pickSecondaryStream to
  // distinguish them in the UI.
  remoteStreams: Map<string, MediaStream[]>;
  handAcceptedBy: string | null; // when student hand is accepted, this is the teacher's socketId
};

/**
 * Merge two id-keyed arrays preserving order. Items in `incoming` win on
 * conflict so a fresh `question:answered` realtime event overwrites the
 * historical row from REST. Used for chat + question history loading.
 */
function mergeById<T extends { id: string }>(incoming: T[], existing: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  for (const item of existing) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Primary = the stream carrying audio (teacher screen+mic, or student's combined av). */
export function pickPrimaryStream(
  streams: MediaStream[] | undefined,
): MediaStream | null {
  if (!streams || streams.length === 0) return null;
  return streams.find((s) => s.getAudioTracks().length > 0) ?? streams[0];
}

/** Secondary = an additional video-only stream (typically the teacher's webcam). */
export function pickSecondaryStream(
  streams: MediaStream[] | undefined,
  primary: MediaStream | null,
): MediaStream | null {
  if (!streams || streams.length === 0) return null;
  return streams.find((s) => s !== primary && s.getVideoTracks().length > 0) ?? null;
}

export type LiveRoomActions = {
  sendChat: (text: string, attachment?: ChatAttachment | null) => void;
  askQuestion: (text: string) => void;
  answerQuestion: (questionId: string, answerText: string) => void;
  raiseHand: (raised: boolean) => void;
  acceptHand: (studentSocketId: string) => void;
  rejectHand: (studentSocketId: string) => void;
  publish: (stream: MediaStream | null) => void;
  // Add/remove an à-la-carte track (e.g. teacher webcam on top of the screen
  // share). Does not replace the main published stream.
  addTrack: (track: MediaStreamTrack, stream: MediaStream) => void;
  removeTrack: (track: MediaStreamTrack) => void;
  // Broadcast mic/cam UI state. Actual audio/video toggling is done by the
  // caller via track.enabled or by calling addTrack/removeTrack.
  setMedia: (patch: { isMicOn?: boolean; isCamOn?: boolean }) => void;
  // Tell peers to drop a specific stream from their UI (pair with
  // removeTrack / unpublish — WebRTC track-end signals are flaky).
  streamGone: (streamId: string) => void;
  leave: () => void;
};

/**
 * Connects to the live room for `sessionId` and manages chat, questions,
 * participant list, and WebRTC mesh peers. The caller is responsible for
 * providing a MediaStream via `publish()` when it wants to broadcast.
 *
 * When `courseId` is supplied we also pull historical chat + questions
 * via REST so users joining late see the full conversation. Realtime
 * events (`chat:new`, `question:new`, `question:answered`) are merged
 * by id, so duplicates from history + socket are deduped.
 */
export function useLiveRoom(
  sessionId: string,
  enabled = true,
  courseId?: string,
): [LiveRoomState, LiveRoomActions] {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mySocketId, setMySocketId] = useState<string | undefined>();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream[]>>(new Map());
  const [handAcceptedBy, setHandAcceptedBy] = useState<string | null>(null);

  const socketRef = useRef<OLPSocket | null>(null);
  const meshRef = useRef<RTCMesh | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;

    (async () => {
      let s: OLPSocket;
      try {
        s = await connectSocket(sessionId);
      } catch (e: any) {
        console.warn('[liveroom] socket connect failed:', e);
        setError(e?.message ?? 'socket unreachable');
        return;
      }
      if (cancelled) {
        s.disconnect();
        return;
      }
      socketRef.current = s;
      const mesh = new RTCMesh(
        s,
        () => s.id,
        {
          onRemoteStream: (id, stream) =>
            setRemoteStreams((m) => {
              const n = new Map(m);
              const list = n.get(id) ?? [];
              if (!list.some((x) => x.id === stream.id)) {
                n.set(id, [...list, stream]);
              } else {
                n.set(id, list);
              }
              return n;
            }),
          onPeerClosed: (id) =>
            setRemoteStreams((m) => {
              const n = new Map(m);
              n.delete(id);
              return n;
            }),
        },
      );
      meshRef.current = mesh;

      const joinRoom = () => {
        setMySocketId(s.id);
        setConnected(true);
        s.emit('room:join', sessionId, (r) => {
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setParticipants(r.participants);
          // Initiate WebRTC handshake with everyone already in the room
          for (const p of r.participants) if (p.socketId !== s.id) mesh.connectTo(p.socketId);
        });
      };
      // If the socket already connected before we attached the handler
      // (can happen on very fast links), fire the join flow immediately.
      if (s.connected) joinRoom();
      s.on('connect', joinRoom);
      s.on('connect_error', (e) => {
        console.warn('[live] connect_error:', e.message);
        setError(e.message);
      });
      s.on('disconnect', () => {
        setConnected(false);
      });

      s.on('room:state', ({ participants }) => {
        setParticipants(participants);
        // Idempotent safety net: if room:joined was missed (slow network,
        // reconnect, etc.), make sure we have peer connections to everyone.
        for (const p of participants) {
          if (p.socketId !== s.id) mesh.connectTo(p.socketId);
        }
      });
      s.on('room:joined', (p) => {
        setParticipants((xs) => [...xs.filter((x) => x.socketId !== p.socketId), p]);
        mesh.connectTo(p.socketId);
      });
      s.on('room:left', (p) => {
        setParticipants((xs) => xs.filter((x) => x.socketId !== p.socketId));
        mesh.closePeer(p.socketId);
      });
      s.on('room:updated', (p) => {
        setParticipants((xs) => xs.map((x) => (x.socketId === p.socketId ? p : x)));
      });

      // Dedupe by id — historical fetch + realtime socket can both deliver
      // the same row; whichever arrives second should overwrite, not append.
      s.on('chat:new', (msg) =>
        setChat((xs) => {
          if (xs.some((x) => x.id === msg.id)) return xs;
          return [...xs, msg];
        }),
      );
      s.on('question:new', (q) =>
        setQuestions((xs) => {
          if (xs.some((x) => x.id === q.id)) return xs;
          return [...xs, q];
        }),
      );
      s.on('question:answered', (q) =>
        setQuestions((xs) => {
          // Defensive: if the student joined AFTER the question was asked
          // and missed `question:new`, seed it now so the answer is visible.
          if (!xs.some((x) => x.id === q.id)) return [...xs, q];
          return xs.map((x) => (x.id === q.id ? q : x));
        }),
      );

      // Server pushes chat + question backlog right after room:join ack,
      // so late joiners see the live conversation in full without depending
      // on the REST fetch below (which can race / fail under guest-token edge
      // cases). mergeById keeps duplicates from chat:new + REST aligned.
      s.on('chat:history', (msgs) => setChat((xs) => mergeById(msgs, xs)));
      s.on('question:history', (qs) => setQuestions((xs) => mergeById(qs, xs)));

      s.on('hand:accepted', ({ fromSocketId }) => setHandAcceptedBy(fromSocketId));
      s.on('hand:rejected', () => setHandAcceptedBy(null));

      // Pull chat + question history in parallel with the socket join so
      // the panels never appear empty for late joiners. Skipped silently
      // if courseId isn't supplied (legacy callers).
      if (courseId) {
        void api<unknown[]>(
          `/courses/${courseId}/sessions/${sessionId}/uploads/messages`,
        )
          .then((rows) => {
            if (cancelled) return;
            const msgs: ChatMessage[] = (rows as Array<Record<string, unknown>>).map(
              (m) => ({
                id: String(m.id),
                sessionId: String(m.sessionId),
                userId: String(m.userId ?? ''),
                userName: String(m.userName ?? m.guestName ?? 'Guest'),
                userRole: 'STUDENT' as Participant['role'],
                text: String(m.text ?? ''),
                attachment: m.attachmentKey
                  ? {
                      key: String(m.attachmentKey),
                      name: String(m.attachmentName ?? 'attachment'),
                      mimeType: String(
                        m.attachmentMimeType ?? 'application/octet-stream',
                      ),
                      size: Number(m.attachmentSize ?? 0),
                    }
                  : null,
                createdAt:
                  m.createdAt instanceof Date
                    ? m.createdAt.toISOString()
                    : String(m.createdAt),
              }),
            );
            setChat((xs) => mergeById(msgs, xs));
          })
          .catch(() => {
            /* non-fatal: panels just stay empty */
          });

        void api<Question[]>(
          `/courses/${courseId}/sessions/${sessionId}/questions`,
        )
          .then((rows) => {
            if (cancelled) return;
            setQuestions((xs) => mergeById(rows, xs));
          })
          .catch(() => {
            /* non-fatal */
          });
      }

      s.on('media:stream-gone', ({ fromSocketId, streamId }) => {
        setRemoteStreams((m) => {
          const list = m.get(fromSocketId);
          if (!list) return m;
          const next = list.filter((x) => x.id !== streamId);
          const n = new Map(m);
          if (next.length === 0) n.delete(fromSocketId);
          else n.set(fromSocketId, next);
          return n;
        });
      });
    })();

    return () => {
      cancelled = true;
      meshRef.current?.closeAll();
      if (socketRef.current) {
        socketRef.current.emit('room:leave', sessionId);
        socketRef.current.disconnect();
      }
      socketRef.current = null;
      meshRef.current = null;
    };
  }, [sessionId, enabled, courseId]);

  const actions: LiveRoomActions = {
    sendChat: useCallback(
      (text: string, attachment?: ChatAttachment | null) => {
        if (!text.trim() && !attachment) return;
        socketRef.current?.emit('chat:send', { sessionId, text, attachment });
      },
      [sessionId],
    ),
    askQuestion: useCallback(
      (text: string) => {
        if (!text.trim()) return;
        socketRef.current?.emit('question:ask', { sessionId, text });
      },
      [sessionId],
    ),
    answerQuestion: useCallback(
      (questionId: string, answerText: string) => {
        if (!answerText.trim()) return;
        socketRef.current?.emit('question:answer', { sessionId, questionId, answerText });
      },
      [sessionId],
    ),
    raiseHand: useCallback(
      (raised: boolean) =>
        socketRef.current?.emit('hand:raise', { sessionId, raised }),
      [sessionId],
    ),
    acceptHand: useCallback(
      (studentSocketId: string) =>
        socketRef.current?.emit('hand:accept', { sessionId, studentSocketId }),
      [sessionId],
    ),
    rejectHand: useCallback(
      (studentSocketId: string) =>
        socketRef.current?.emit('hand:reject', { sessionId, studentSocketId }),
      [sessionId],
    ),
    publish: useCallback((stream: MediaStream | null) => {
      // setLocalStream adds the tracks to every existing peer. addTrack
      // fires `negotiationneeded` on each RTCPeerConnection, which our
      // handler in rtc.ts uses to push a fresh offer. No manual
      // "connectTo for each participant" dance needed.
      meshRef.current?.setLocalStream(stream);
    }, []),
    addTrack: useCallback((track: MediaStreamTrack, stream: MediaStream) => {
      meshRef.current?.addLocalTrack(track, stream);
    }, []),
    removeTrack: useCallback((track: MediaStreamTrack) => {
      meshRef.current?.removeLocalTrack(track);
    }, []),
    setMedia: useCallback(
      (patch: { isMicOn?: boolean; isCamOn?: boolean }) => {
        socketRef.current?.emit('media:toggle', { sessionId, ...patch });
      },
      [sessionId],
    ),
    streamGone: useCallback(
      (streamId: string) => {
        socketRef.current?.emit('media:stream-gone', { sessionId, streamId });
      },
      [sessionId],
    ),
    leave: useCallback(() => {
      meshRef.current?.closeAll();
      socketRef.current?.emit('room:leave', sessionId);
    }, [sessionId]),
  };

  // Keep a ref of participants for publish() to reconnect everyone
  const participantsRef = useRef<Participant[]>([]);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  return [
    { connected, error, mySocketId, participants, chat, questions, remoteStreams, handAcceptedBy },
    actions,
  ];
}
