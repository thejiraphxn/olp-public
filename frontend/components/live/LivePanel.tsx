'use client';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import type { LiveRoomActions, LiveRoomState } from './useLiveRoom';
import type { ChatAttachment, Participant } from '@/lib/live-types';
import { AttachmentView } from './AttachmentView';
import { api } from '@/lib/api';
import { CourseRole } from '@/lib/enums';
import { playChime, ensureNotificationPermission, showDesktopNotification } from '@/lib/notify';
import { useToast } from '@/components/ui/Toast';

type Props = {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
  courseId: string;
  sessionId: string;
  // Optional controlled mode — when both provided, the parent owns the tab
  // state. Used by the record-page side panel where the control bar
  // dictates which tab is open. When omitted, the panel falls back to its
  // own internal state.
  tab?: LivePanelTab;
  onTabChange?: (t: LivePanelTab) => void;
  onClose?: () => void;
  // Track tab — shown when a transcript exists (post-recording) or
  // explicitly enabled. Hidden by default during live before transcript.
  transcript?: TranscriptSegment[] | null;
  // Notes (local-only stub for now — Phase 2 will persist per-user).
  // Caller decides where to source/store; if omitted, the Track→Note tab
  // shows an "unsaved" pad backed by sessionStorage.
  note?: string;
  onNoteChange?: (text: string) => void;
  showPeopleTab?: boolean;
};

export const LivePanelTab = {
  CHAT: 'chat',
  QUESTIONS: 'questions',
  PEOPLE: 'people',
  TRACK: 'track',
} as const;
export type LivePanelTab = (typeof LivePanelTab)[keyof typeof LivePanelTab];

export type TranscriptSegment = {
  startSec: number;
  endSec: number;
  text: string;
};

export function LivePanel({
  state,
  actions,
  myRole,
  courseId,
  sessionId,
  tab: controlledTab,
  onTabChange,
  onClose,
  transcript,
  note,
  onNoteChange,
  showPeopleTab = true,
}: Props) {
  const trackEnabled = Array.isArray(transcript) || onNoteChange !== undefined;
  const [internalTab, setInternalTab] = useState<LivePanelTab>(LivePanelTab.CHAT);
  const tab = controlledTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;
  const unansweredCount = state.questions.filter((q) => !q.answeredAt).length;
  const handsRaised = state.participants.filter(
    (p) => p.role === CourseRole.STUDENT && p.hasHandRaised,
  ).length;
  const toast = useToast();

  useEffect(() => {
    if (showPeopleTab) return;
    if (tab === LivePanelTab.PEOPLE) {
      setTab(LivePanelTab.CHAT);
    }
  }, [showPeopleTab, tab, setTab]);

  // Ask for desktop notification permission once the teacher opens the room.
  useEffect(() => {
    if (myRole === CourseRole.TEACHER) void ensureNotificationPermission();
  }, [myRole]);

  // Detect new hand raises and notify the teacher (sound + toast + desktop).
  const prevHandsRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (myRole !== CourseRole.TEACHER) return;
    const next = new Map<string, boolean>();
    const newly: Participant[] = [];
    for (const p of state.participants) {
      next.set(p.socketId, p.hasHandRaised);
      if (
        p.role === CourseRole.STUDENT &&
        p.hasHandRaised &&
        !prevHandsRef.current.get(p.socketId)
      ) {
        newly.push(p);
      }
    }
    prevHandsRef.current = next;
    for (const p of newly) {
      playChime();
      toast.info(`✋ ${p.name} raised their hand`);
      void showDesktopNotification(
        `${p.name} raised their hand`,
        'Click to open the classroom',
        { tag: `hand:${p.socketId}` },
      );
    }
  }, [state.participants, myRole, toast]);

  // Notify on new unanswered questions too (teacher only).
  const prevQCountRef = useRef(0);
  useEffect(() => {
    if (myRole !== CourseRole.TEACHER) return;
    if (unansweredCount > prevQCountRef.current) {
      const newest = state.questions[state.questions.length - 1];
      if (newest && !newest.answeredAt) {
        playChime();
        toast.info(`❓ ${newest.askedByName} asked a question`);
        void showDesktopNotification(
          `New question from ${newest.askedByName}`,
          newest.text.slice(0, 100),
          { tag: `q:${newest.id}` },
        );
      }
    }
    prevQCountRef.current = unansweredCount;
  }, [unansweredCount, state.questions, myRole, toast]);

  return (
    <div className="border border-ink rounded flex flex-col bg-paper overflow-hidden h-full min-h-0">
      <div className="flex border-b border-ink bg-paper-alt items-stretch overflow-x-auto">
        <TabBtn active={tab === LivePanelTab.CHAT} onClick={() => setTab(LivePanelTab.CHAT)}>
          Chat <span className="text-[10px] font-mono text-ink-mute ml-1">{state.chat.length}</span>
        </TabBtn>
        <TabBtn
          active={tab === LivePanelTab.QUESTIONS}
          onClick={() => setTab(LivePanelTab.QUESTIONS)}
        >
          Questions{' '}
          {unansweredCount > 0 && (
            <span className="ml-1 px-1.5 rounded-full bg-warn text-white text-[10px] font-bold">
              {unansweredCount}
            </span>
          )}
        </TabBtn>
        {showPeopleTab && (
          <TabBtn active={tab === LivePanelTab.PEOPLE} onClick={() => setTab(LivePanelTab.PEOPLE)}>
            People{' '}
            {handsRaised > 0 && (
              <span className="ml-1 px-1.5 rounded-full bg-warn text-white text-[10px] font-bold animate-pulse">
                ✋ {handsRaised}
              </span>
            )}
            <span className="text-[10px] font-mono text-ink-mute ml-1">
              {state.participants.length}
            </span>
          </TabBtn>
        )}
        {trackEnabled && (
          <TabBtn active={tab === LivePanelTab.TRACK} onClick={() => setTab(LivePanelTab.TRACK)}>
            Track
          </TabBtn>
        )}
        {onClose && (
          <button
            onClick={onClose}
            aria-label="close panel"
            className="ml-auto px-3 text-ink-soft hover:bg-paper border-l border-ink/20 text-lg"
          >
            ✕
          </button>
        )}
      </div>

      {tab === LivePanelTab.CHAT && (
        <ChatTab
          state={state}
          actions={actions}
          courseId={courseId}
          sessionId={sessionId}
        />
      )}
      {tab === LivePanelTab.QUESTIONS && (
        <QuestionsTab state={state} actions={actions} myRole={myRole} />
      )}
      {showPeopleTab && tab === LivePanelTab.PEOPLE && (
        <PeopleTab state={state} actions={actions} myRole={myRole} />
      )}
      {tab === LivePanelTab.TRACK && (
        <TrackTab
          transcript={transcript ?? null}
          note={note}
          onNoteChange={onNoteChange}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}

const TrackSubTab = { TRANSCRIPT: 'transcript', NOTE: 'note' } as const;
type TrackSubTab = (typeof TrackSubTab)[keyof typeof TrackSubTab];

function TrackTab({
  transcript,
  note,
  onNoteChange,
  sessionId,
}: {
  transcript: TranscriptSegment[] | null;
  note: string | undefined;
  onNoteChange: ((t: string) => void) | undefined;
  sessionId: string;
}) {
  const [sub, setSub] = useState<TrackSubTab>(TrackSubTab.TRANSCRIPT);
  const [search, setSearch] = useState('');

  // When the parent doesn't manage notes, fall back to a per-session
  // sessionStorage scratchpad so the user's text survives tab switches.
  const storageKey = `olp_note:${sessionId}`;
  const [localNote, setLocalNote] = useState('');
  useEffect(() => {
    if (onNoteChange) return;
    try {
      setLocalNote(window.sessionStorage.getItem(storageKey) ?? '');
    } catch {
      /* private mode */
    }
  }, [storageKey, onNoteChange]);

  const noteValue = onNoteChange ? note ?? '' : localNote;
  const setNote = (v: string) => {
    if (onNoteChange) {
      onNoteChange(v);
      return;
    }
    setLocalNote(v);
    try {
      window.sessionStorage.setItem(storageKey, v);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex border-b border-ink/15 bg-paper-alt/40">
        <SubTabBtn active={sub === TrackSubTab.TRANSCRIPT} onClick={() => setSub(TrackSubTab.TRANSCRIPT)}>
          Transcript {transcript ? `· ${transcript.length}` : ''}
        </SubTabBtn>
        <SubTabBtn active={sub === TrackSubTab.NOTE} onClick={() => setSub(TrackSubTab.NOTE)}>
          Note
        </SubTabBtn>
      </div>

      {sub === TrackSubTab.TRANSCRIPT && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="p-2 border-b border-ink/10">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search transcript…"
              className="w-full h-8 px-2 border border-ink/30 rounded text-xs bg-paper"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-3 text-sm flex flex-col gap-2">
            {(!transcript || transcript.length === 0) && (
              <div className="text-xs text-ink-mute text-center my-6">
                No transcript yet.
              </div>
            )}
            {transcript &&
              transcript
                .filter((s) =>
                  search
                    ? s.text.toLowerCase().includes(search.toLowerCase())
                    : true,
                )
                .map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="font-mono text-[10px] text-ink-mute pt-0.5 shrink-0 w-12">
                      {fmtSec(s.startSec)}
                    </span>
                    <span>{s.text}</span>
                  </div>
                ))}
          </div>
        </div>
      )}

      {sub === TrackSubTab.NOTE && (
        <div className="flex flex-col flex-1 min-h-0 p-2 gap-1">
          <textarea
            value={noteValue}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Type your notes here…"
            className="flex-1 w-full p-2 border border-ink/30 rounded text-sm bg-paper resize-none font-sans"
          />
          <div className="text-[10px] text-ink-mute font-mono">
            {onNoteChange
              ? 'auto-saved'
              : 'unsaved · stored in this browser tab only'}
          </div>
        </div>
      )}
    </div>
  );
}

function SubTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px',
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-ink-soft hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function fmtSec(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// AttachmentView lives in ./AttachmentView.tsx — shared with the playback
// page's chat-history tab so live + replay render media the same way.

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex-1 py-2.5 text-sm font-semibold border-r last:border-r-0 border-ink/20',
        active ? 'bg-paper text-accent border-b-2 border-b-accent -mb-px' : 'text-ink-soft hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ChatTab({
  state,
  actions,
  courseId,
  sessionId,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  courseId: string;
  sessionId: string;
}) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 9999999, behavior: 'smooth' });
  }, [state.chat.length]);

  async function pickAndUpload(file: File) {
    setUploading(true);
    try {
      const init = await api<{ url: string; key: string }>(
        `/courses/${courseId}/sessions/${sessionId}/uploads/init`,
        {
          method: 'POST',
          body: {
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          },
        },
      );
      const res = await fetch(init.url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      setPendingAttachment({
        key: init.key,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      });
    } catch (e: any) {
      toast.error(e?.message ?? 'upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !pendingAttachment) return;
    actions.sendChat(text, pendingAttachment);
    setText('');
    setPendingAttachment(null);
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 flex flex-col gap-2 text-sm">
        {state.chat.length === 0 && (
          <div className="text-xs text-ink-mute text-center my-6">
            No messages yet. Say hi 👋
          </div>
        )}
        {state.chat.map((m) => (
          <div key={m.id} className="flex gap-2 items-start">
            <Avatar name={m.userName} size={24} />
            <div className="min-w-0 flex-1">
              <div className="flex gap-1.5 items-baseline">
                <span className="font-bold text-xs">{m.userName}</span>
                {m.userRole === CourseRole.TEACHER && (
                  <span className="text-[9px] text-accent font-bold">TEACHER</span>
                )}
                <span className="font-mono text-[10px] text-ink-mute">
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {m.text && <div className="text-sm break-words">{m.text}</div>}
              {m.attachment && (
                <AttachmentView
                  attachment={m.attachment}
                  courseId={courseId}
                  sessionId={sessionId}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {pendingAttachment && (
        <div className="px-2 pt-2 flex items-center gap-2 text-xs bg-accent-soft/60 border-t border-ink">
          <span>📎</span>
          <span className="truncate flex-1">{pendingAttachment.name}</span>
          <span className="text-ink-mute font-mono">
            {Math.round(pendingAttachment.size / 1024)} KB
          </span>
          <button
            type="button"
            onClick={() => setPendingAttachment(null)}
            className="text-ink-mute hover:text-live"
          >
            ×
          </button>
        </div>
      )}
      <form className="border-t border-ink p-2 flex gap-2" onSubmit={submit}>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) pickAndUpload(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!state.connected || uploading}
          title="Attach file"
          className="h-9 w-9 border border-ink rounded flex items-center justify-center hover:bg-paper-alt disabled:opacity-50"
        >
          {uploading ? '…' : '📎'}
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={state.connected ? 'Message…' : 'Connecting…'}
          disabled={!state.connected}
          className="flex-1 h-9 px-2 border border-ink rounded text-sm"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!state.connected || (!text.trim() && !pendingAttachment)}
        >
          Send
        </Button>
      </form>
    </>
  );
}

function QuestionsTab({
  state,
  actions,
  myRole,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
}) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3 text-sm">
        {state.questions.length === 0 && (
          <div className="text-xs text-ink-mute text-center my-6">
            {myRole === CourseRole.STUDENT
              ? 'No questions yet. Ask below — the teacher will see it live or answer later.'
              : 'Questions from students will appear here in real time.'}
          </div>
        )}
        {state.questions.map((q) => (
          <QuestionItem key={q.id} q={q} myRole={myRole} answer={actions.answerQuestion} />
        ))}
      </div>
      {myRole === CourseRole.STUDENT && (
        <form
          className="border-t border-ink p-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            actions.askQuestion(draft);
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.connected ? 'Ask the teacher…' : 'Connecting…'}
            disabled={!state.connected}
            className="flex-1 h-9 px-2 border border-ink rounded text-sm"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!state.connected || !draft.trim()}
          >
            Ask
          </Button>
        </form>
      )}
    </>
  );
}

function QuestionItem({
  q,
  myRole,
  answer,
}: {
  q: import('@/lib/live-types').Question;
  myRole: CourseRole;
  answer: (id: string, text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState(false);
  return (
    <div className="border border-ink rounded p-2.5 flex flex-col gap-2 bg-paper">
      <div className="flex items-start gap-2">
        <Avatar name={q.askedByName} size={22} />
        <div className="flex-1 min-w-0">
          <div className="flex gap-1.5 items-baseline">
            <span className="font-bold text-xs">{q.askedByName}</span>
            <span className="font-mono text-[10px] text-ink-mute">
              {new Date(q.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <div className="text-sm mt-0.5">{q.text}</div>
        </div>
        {!q.answeredAt && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 bg-warn-soft text-warn border border-warn rounded">
            unanswered
          </span>
        )}
      </div>
      {q.answeredAt && q.answerText && (
        <div className="ml-8 border-l-2 border-accent pl-2 text-sm bg-accent-soft/30 rounded py-1">
          <div className="text-[10px] text-accent font-bold">
            ANSWERED by {q.answeredByName}
          </div>
          {q.answerText}
        </div>
      )}
      {myRole === CourseRole.TEACHER && !q.answeredAt && (
        <>
          {!answering ? (
            <button
              onClick={() => setAnswering(true)}
              className="text-xs text-accent hover:underline text-left ml-8"
            >
              ↩ Answer
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                answer(q.id, draft);
                setDraft('');
                setAnswering(false);
              }}
              className="ml-8 flex gap-2"
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Your answer…"
                className="flex-1 h-8 px-2 border border-ink rounded text-sm"
              />
              <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
                Send
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function PeopleTab({
  state,
  actions,
  myRole,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
}) {
  return (
    <div className="flex-1 overflow-auto p-3 flex flex-col gap-1.5 text-sm">
      {state.participants.map((p) => (
        <div
          key={p.socketId}
          className="flex items-center gap-2 p-1.5 rounded hover:bg-paper-alt"
        >
          <Avatar name={p.name} size={24} />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{p.name}</div>
            <div className="flex gap-1.5 items-center">
              <span
                className={
                  p.role === CourseRole.TEACHER
                    ? 'text-[10px] font-bold text-accent'
                    : 'text-[10px] text-ink-mute'
                }
              >
                {p.role}
              </span>
              {p.isPublishing && (
                <span className="text-[10px] text-live font-bold">● live</span>
              )}
              {p.isPublishing && (
                <span
                  className={`text-[10px] ${p.isMicOn ? 'text-ink-soft' : 'text-ink-mute line-through'}`}
                  title={p.isMicOn ? 'Mic on' : 'Mic muted'}
                >
                  {p.isMicOn ? '🎤' : '🔇'}
                </span>
              )}
              {p.isPublishing && (
                <span
                  className={`text-[10px] ${p.isCamOn ? 'text-ink-soft' : 'text-ink-mute line-through'}`}
                  title={p.isCamOn ? 'Camera on' : 'Camera off'}
                >
                  {p.isCamOn ? '📹' : '📷'}
                </span>
              )}
              {p.hasHandRaised && (
                <span className="text-[10px] text-warn font-bold">✋ hand up</span>
              )}
            </div>
          </div>
          {myRole === CourseRole.TEACHER && p.hasHandRaised && p.role === CourseRole.STUDENT && (
            <div className="flex gap-1">
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
          )}
        </div>
      ))}
    </div>
  );
}
