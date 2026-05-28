/**
 * Shared socket event types. Imported on both server and (copied to) client.
 *
 * Room key = `session:<sessionId>`. One room per session.
 */

import type { CourseRole } from '@prisma/client';
export type Role = CourseRole;

export type Participant = {
  socketId: string;
  userId: string;
  name: string;
  role: Role;
  hasHandRaised: boolean;
  isPublishing: boolean; // allowed to publish cam/mic tracks into the mesh
  isMicOn: boolean; // live mic state (muted via track.enabled=false on client)
  isCamOn: boolean; // live camera state
};

// Client → Server
export interface ClientToServerEvents {
  'room:join': (sessionId: string, ack: (r: RoomJoinResult) => void) => void;
  'room:leave': (sessionId: string) => void;

  'chat:send': (payload: {
    sessionId: string;
    text: string;
    attachment?: ChatAttachment | null;
  }) => void;
  'question:ask': (payload: { sessionId: string; text: string }) => void;
  'question:answer': (payload: {
    sessionId: string;
    questionId: string;
    answerText: string;
  }) => void;

  'hand:raise': (payload: { sessionId: string; raised: boolean }) => void;
  'hand:accept': (payload: { sessionId: string; studentSocketId: string }) => void;
  'hand:reject': (payload: { sessionId: string; studentSocketId: string }) => void;

  // Broadcast mic/cam UI state so peers can render indicators. Actual media
  // track toggling happens client-side via track.enabled; this event is
  // purely for UI reflection of that state.
  'media:toggle': (payload: {
    sessionId: string;
    isMicOn?: boolean;
    isCamOn?: boolean;
  }) => void;
  // Emitted when a peer stops publishing a specific media stream (e.g. the
  // teacher turns off the webcam). Lets remote clients drop the stale
  // stream from their UI without waiting for WebRTC track-ended signals,
  // which are flaky across browsers.
  'media:stream-gone': (payload: { sessionId: string; streamId: string }) => void;

  // WebRTC signaling — relayed verbatim to the `to` socket
  'rtc:offer': (payload: { to: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:answer': (payload: { to: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:ice': (payload: { to: string; candidate: RTCIceCandidateInit }) => void;
}

// Server → Client
export interface ServerToClientEvents {
  'room:state': (state: { participants: Participant[] }) => void;
  'room:joined': (p: Participant) => void;
  'room:left': (p: Pick<Participant, 'socketId' | 'userId' | 'name'>) => void;
  'room:updated': (p: Participant) => void;

  'chat:new': (msg: ChatMessage) => void;
  // Sent only to the joining socket immediately after room:join ack so late
  // joiners see the existing chat without an extra REST round-trip. Client
  // dedupes by id when these merge with chat:new events that arrived first.
  'chat:history': (msgs: ChatMessage[]) => void;
  'question:new': (q: Question) => void;
  // Same backlog pattern as chat:history but for questions.
  'question:history': (qs: Question[]) => void;
  'question:answered': (q: Question) => void;

  'hand:accepted': (payload: { fromSocketId: string }) => void;
  'hand:rejected': () => void;

  // Relayed verbatim from the publishing peer.
  'media:stream-gone': (payload: { fromSocketId: string; streamId: string }) => void;

  'rtc:offer': (payload: { from: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:answer': (payload: { from: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:ice': (payload: { from: string; candidate: RTCIceCandidateInit }) => void;
}

export type RoomJoinResult =
  | { ok: true; participants: Participant[] }
  | { ok: false; error: string };

export type ChatAttachment = {
  key: string;
  name: string;
  mimeType: string;
  size: number;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  userId: string;
  userName: string;
  userRole: Role;
  text: string;
  attachment: ChatAttachment | null;
  createdAt: string;
};

export type Question = {
  id: string;
  sessionId: string;
  // Null when asked by a guest (no User row); name falls back to the
  // guest display name from the JWT.
  askedByUserId: string | null;
  askedByName: string;
  text: string;
  answeredAt: string | null;
  answeredByUserId: string | null;
  answeredByName: string | null;
  answerText: string | null;
  createdAt: string;
};
