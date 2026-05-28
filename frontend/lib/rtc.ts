'use client';
/**
 * WebRTC mesh manager using the "Perfect Negotiation" pattern, straight from
 * the W3C spec. Key properties:
 *
 *   - `pc.onnegotiationneeded` fires when tracks are added/removed — we
 *     auto-send an offer with `setLocalDescription()` (no args) which lets
 *     the browser generate the correct SDP for the current state.
 *
 *   - Glare (both sides offer at once) is resolved by the polite/impolite
 *     roles derived from socket ids. Modern browsers roll back their own
 *     in-flight local description implicitly when we call
 *     `setRemoteDescription(offer)` during a collision.
 *
 *   - ICE candidates that arrive before the remote description are queued
 *     and flushed once it's applied.
 */
import type { OLPSocket } from './socket';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export type PeerState = {
  socketId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
};

export type RTCMeshCallbacks = {
  onRemoteStream: (socketId: string, stream: MediaStream) => void;
  onPeerClosed: (socketId: string) => void;
};

export class RTCMesh {
  private peers = new Map<string, PeerState>();
  private localStream: MediaStream | null = null;
  // Tracks added via addLocalTrack (on top of the bulk localStream). Needed
  // so new peers that connect later get these tracks too.
  private extraLocalTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();
  private socket: OLPSocket;
  private mySocketId: () => string | undefined;
  private cb: RTCMeshCallbacks;

  constructor(socket: OLPSocket, mySocketId: () => string | undefined, cb: RTCMeshCallbacks) {
    this.socket = socket;
    this.mySocketId = mySocketId;
    this.cb = cb;

    socket.on('rtc:offer', async ({ from, sdp }) => {
      const peer = this.ensurePeerState(from);
      const pc = peer.pc;

      // Glare: we have a collision if we're in the middle of offering too,
      // or if our signaling state isn't stable.
      const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
      const polite = this.isPolite(from);
      peer.ignoreOffer = !polite && offerCollision;
      if (peer.ignoreOffer) {
        console.log('[rtc] ignoring offer (impolite, glare)', { from });
        return;
      }

      try {
        // setRemoteDescription(offer) on a polite peer during glare implicitly
        // rolls back any local offer — no explicit {type: 'rollback'} needed
        // in modern browsers (Chrome 80+, FF 75+, Safari 15.4+).
        await pc.setRemoteDescription(sdp);
        await this.flushPendingIce(peer);

        // If we have a stream of our own, add its tracks before answering so
        // the answer advertises them. For a typical classroom, only the
        // teacher (on hand-raise accept also the student) has a stream.
        if (this.localStream) {
          for (const track of this.localStream.getTracks()) {
            const already = pc.getSenders().some((s) => s.track?.id === track.id);
            if (!already) pc.addTrack(track, this.localStream);
          }
        }
        // Also attach any à-la-carte tracks (e.g. teacher's webcam added on
        // top of the screen-share).
        for (const { track, stream } of this.extraLocalTracks.values()) {
          const already = pc.getSenders().some((s) => s.track?.id === track.id);
          if (!already) pc.addTrack(track, stream);
        }

        // setLocalDescription() with no args auto-creates the appropriate
        // answer based on current signaling state.
        await pc.setLocalDescription();
        this.socket.emit('rtc:answer', { to: from, sdp: pc.localDescription! });
      } catch (e) {
        console.warn('[rtc] offer handler failed', e);
      }
    });

    socket.on('rtc:answer', async ({ from, sdp }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      try {
        await peer.pc.setRemoteDescription(sdp);
        await this.flushPendingIce(peer);
      } catch (e) {
        console.warn('[rtc] setRemoteDescription(answer) failed', e);
      }
    });

    socket.on('rtc:ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      // Queue until remote description is set.
      if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
        peer.pendingIce.push(candidate);
        return;
      }
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (e) {
        if (!peer.ignoreOffer) console.warn('[rtc] addIceCandidate failed', e);
      }
    });
  }

  private isPolite(remoteId: string): boolean {
    // Polite = lexicographically greater socket id. Polite peer rolls back
    // on glare; impolite peer wins.
    const mine = this.mySocketId() ?? '';
    return mine > remoteId;
  }

  private async flushPendingIce(peer: PeerState) {
    while (peer.pendingIce.length > 0) {
      const c = peer.pendingIce.shift()!;
      try {
        await peer.pc.addIceCandidate(c);
      } catch (e) {
        console.warn('[rtc] queued addIceCandidate failed', e);
      }
    }
  }

  private ensurePeerState(remoteId: string): PeerState {
    const existing = this.peers.get(remoteId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const state: PeerState = {
      socketId: remoteId,
      pc,
      stream: null,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
    };
    this.peers.set(remoteId, state);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.socket.emit('rtc:ice', { to: remoteId, candidate: ev.candidate.toJSON() });
      }
    };
    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      const p = this.peers.get(remoteId);
      if (p) p.stream = stream;
      console.log('[rtc] ontrack', { from: remoteId, kind: ev.track.kind });
      this.cb.onRemoteStream(remoteId, stream);
    };
    pc.onconnectionstatechange = () => {
      console.log('[rtc] connectionState', { remoteId, state: pc.connectionState });
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.closePeer(remoteId);
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        // Implicit createOffer + setLocalDescription — the browser picks the
        // right SDP based on current state.
        await pc.setLocalDescription();
        this.socket.emit('rtc:offer', { to: remoteId, sdp: pc.localDescription! });
      } catch (e) {
        console.warn('[rtc] negotiationneeded failed', e);
      } finally {
        state.makingOffer = false;
      }
    };

    return state;
  }

  setLocalStream(stream: MediaStream | null) {
    if (!stream) {
      // Unpublishing — detach tracks from all senders so the browser lets
      // go of the mic/screen indicator.
      for (const { pc } of this.peers.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track) sender.replaceTrack(null).catch(() => {});
        }
      }
      this.localStream = null;
      return;
    }
    this.localStream = stream;
    // addTrack fires `negotiationneeded` on each peer. Our handler sends a
    // fresh offer with the new tracks.
    for (const { pc } of this.peers.values()) {
      for (const track of stream.getTracks()) {
        const already = pc.getSenders().some((s) => s.track?.id === track.id);
        if (!already) pc.addTrack(track, stream);
      }
    }
  }

  /**
   * Ensure a peer connection exists for a participant. If we have a local
   * stream, pushing tracks onto the new pc fires `negotiationneeded` which
   * sends the offer. If we don't have a stream yet, we just wait — the
   * other side will initiate once they have tracks to publish.
   */
  async connectTo(remoteId: string) {
    const mine = this.mySocketId();
    if (!mine || remoteId === mine) return;
    const peer = this.ensurePeerState(remoteId);
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const already = peer.pc.getSenders().some((s) => s.track?.id === track.id);
        if (!already) peer.pc.addTrack(track, this.localStream);
      }
    }
    for (const { track, stream } of this.extraLocalTracks.values()) {
      const already = peer.pc.getSenders().some((s) => s.track?.id === track.id);
      if (!already) peer.pc.addTrack(track, stream);
    }
  }

  /**
   * Publish a single track (on top of whatever's in setLocalStream).
   * Used for additive tracks like a teacher's webcam while screen-sharing.
   * addTrack on each peer fires onnegotiationneeded which renegotiates.
   */
  addLocalTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.extraLocalTracks.set(track.id, { track, stream });
    for (const { pc } of this.peers.values()) {
      const already = pc.getSenders().some((s) => s.track?.id === track.id);
      if (!already) pc.addTrack(track, stream);
    }
  }

  /**
   * Stop sending a track previously added via addLocalTrack. Replaces the
   * sender's track with null (keeps the transceiver in place — cheaper than
   * removeTrack, avoids a full m-section rebuild). Caller owns track.stop().
   */
  removeLocalTrack(track: MediaStreamTrack) {
    this.extraLocalTracks.delete(track.id);
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.id === track.id);
      if (sender) sender.replaceTrack(null).catch(() => {});
    }
  }

  closePeer(remoteId: string) {
    const p = this.peers.get(remoteId);
    if (!p) return;
    try {
      p.pc.close();
    } catch {}
    this.peers.delete(remoteId);
    this.cb.onPeerClosed(remoteId);
  }

  closeAll() {
    for (const id of Array.from(this.peers.keys())) this.closePeer(id);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
  }
}
