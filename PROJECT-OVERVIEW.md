# Online Learning Platform — Project Overview

Single source of truth describing what exists in this codebase today
(2026-04-24). For setup steps see [README.md](./README.md). For the original
planning doc see [TECHNICAL-PLAN.md](./TECHNICAL-PLAN.md) (historical — many
items there are now built).

---

## TL;DR

A session-based teaching platform. Teachers create courses with sessions,
go live with screen-share + mic + (optional) webcam, and students watch in
real time, ask questions, raise hands to speak, and replay the session
later with auto-generated transcript + chapter markers.

- **Stack:** Next.js 14 / Express + Socket.IO / Prisma + PostgreSQL / BullMQ + Redis / S3 / FFmpeg / Whisper (Groq) / Ollama Cloud (Gemma 4)
- **Deploy:** Frontend → Vercel · Backend (API + worker) → Render · Postgres + S3 → BYO
- **Roles:** course-level membership (TEACHER / STUDENT) — no global user role

---

## Features (built and shipping)

### Authentication
- Email/password sign-up + login (bcrypt + JWT in HttpOnly cookie)
- Demo persona switcher (`/auth/demo/switch`) — one click swap between seeded accounts for stakeholder demos
- Rate limiting on auth + demo endpoints

### Courses
- Teacher creates course → unique `code` + auto-generated `joinCode`
- Visibility: `PRIVATE` (must be invited / join via code) or `PUBLIC` (anyone can read)
- Cover color from a hand-picked palette
- Membership management: invite by email, change role, kick
- Course delete cascades to sessions/recordings + **also deletes S3 objects** (raw chunks, processed mp4, thumbnails, chat attachments, in-flight multipart uploads aborted)

### Sessions (lifecycle: `DRAFT` → `SCHEDULED` → `LIVE` → `ENDED`)
- Teacher creates a session → optionally schedules it
- Teacher opens record page → preflight check (mic, screen capture, browser support) → goes live
- Browser captures screen + mic via `getDisplayMedia()` + `getUserMedia()`, merges into one MediaStream
- MediaRecorder slices the stream into webm chunks → multipart upload to S3 (`raw/<sessionId>/<ts>.webm`)
- On stop, BullMQ job processes the raw upload (transcode + transcribe + summarize + chapters)

### Live classroom (real-time)
- WebRTC mesh between everyone in the room (Perfect Negotiation pattern, polite/impolite peers determined by socket id)
- Teacher publishes screen + mic as one stream; **optionally** opens webcam as a second separate stream
- Students see screen as the main video + teacher webcam as picture-in-picture (PIP) corner thumbnail
- Webcam stream is NOT recorded to S3 — it goes only through the WebRTC mesh
- Students raise hand → teacher accepts → student auto-publishes mic + camera (separate toggle for each)
- Mute/unmute mic + on/off camera buttons broadcast `media:toggle` so everyone sees indicator state in the People tab
- Stream-gone signal (`media:stream-gone`) cleans up disconnected webcam streams reliably across browsers
- Chat (text + file attachments via S3 presigned PUT)
- Live Q&A — student asks, teacher answers, both visible to room
- Async questions (after the session ends) — same component
- Notifications for the teacher: chime + toast + desktop notification on hand-raise / new question

### Recording pipeline (BullMQ worker)
1. Download raw webm from S3 to a tmp dir
2. FFmpeg transcode → MP4 (H.264 + AAC, 30fps CFR, ultrafast preset, CRF 30 for low memory)
3. Generate thumbnail JPG from first frame
4. Upload mp4 + thumbnail to `processed/<sessionId>/`
5. Whisper (Groq hosted) → transcript (segments with timestamps)
6. LLM (Ollama Cloud Gemma 4) → 2-3 sentence summary + auto-chapters
7. Update `SessionRecording` row → `READY`
8. Auto-recovery on worker startup: any `UPLOADING`/`PROCESSING` rows from a crashed worker are reset and re-enqueued

### Playback
- Video player with HLS-style controls
- Transcript pane with search → click any segment to seek
- Chapters list (manual teacher-authored or LLM auto-generated as fallback)
- Watch progress tracking → "Continue watching" on dashboard
- Focus mode (hides everything except the video)

### Attendance tracking (NEW)
- Every `room:join` writes a `SessionAttendance` row with `joinedAt`
- `room:leave` / `disconnect` stamps `leftAt`
- A user who leaves and rejoins gets multiple stints — total = sum
- Teacher view: collapsible card on session page showing per-student total minutes + stint detail + no-show roster
- Open stint while live shows "live now" indicator
- Crash recovery: orphaned rows on next boot get `leftAt = joinedAt` (zero-duration; undercount is safer than over)

### UI polish
- Tailwind theme with semantic tokens: `live` (red), `accent` (indigo), `warn` (amber), `ok` (green)
- Avatar component (deterministic color hash from name)
- Toast system with stacking + auto-dismiss
- Status pills (live/processing/ready/failed)
- Custom keep-alive ping endpoint `/ping` for free-tier hosts that spin down

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend framework | Next.js 14 (App Router, standalone output) |
| Frontend hosting | Vercel |
| Frontend rewrites | `/api/*` and `/socket.io/*` proxied to backend (same-origin cookies) |
| Backend framework | Express + Socket.IO on the same HTTP server |
| Backend hosting | Render (web service, free tier) |
| ORM | Prisma 5 |
| Database | PostgreSQL 16 (BYO — Supabase, Neon, RDS, etc.) |
| Queue | BullMQ on Redis |
| Redis | Render keyvalue (free) or Upstash |
| Object storage | AWS S3 / S3-compatible (R2, MinIO for dev) |
| Realtime | Socket.IO (wss + JWT auth via handshake or cookie) |
| WebRTC | Native browser RTCPeerConnection mesh |
| Transcode | FFmpeg (debian apt) — VP8/Opus webm → H.264/AAC mp4 |
| Transcription | Groq Whisper API (`whisper-large-v3`) |
| LLM | Ollama Cloud (`gemma4:31b-cloud`) — OpenAI-compatible chat completions |
| Auth | bcryptjs + jsonwebtoken (HS256) |
| Validation | Zod |
| Logging | pino + pino-http |
| Container | Docker (multi-stage, `node:20-bookworm-slim`) |

---

## Architecture (run-time)

```
┌────────────┐   HTTPS    ┌────────────┐   wss / fetch   ┌────────────────────┐
│  Browser   │ ─────────> │  Vercel    │ ──────────────> │  Render: olp-api   │
│  (student/ │            │  (Next.js  │  rewrites:      │  Express + Socket  │
│  teacher)  │ <───WebRTC──┼─peers─────────────────────> │  + BullMQ worker   │
└────────────┘            │  proxy)    │                 │  (embedded)        │
                          └────────────┘                 └─────────┬──────────┘
                                                                   │
                                  ┌────────────────────────────────┼─────────┐
                                  ▼                                ▼         ▼
                          ┌────────────────┐             ┌──────────────┐  ┌────────────┐
                          │  Postgres      │             │  Render      │  │  S3        │
                          │  (BYO ext.)    │             │  Key Value   │  │  (raw +    │
                          │   Prisma       │             │  (Redis)     │  │  processed)│
                          └────────────────┘             └──────────────┘  └────────────┘
                                                              │
                                  ┌───────────────────────────┘
                                  ▼ external HTTP
                          ┌────────────────┐         ┌────────────────┐
                          │  Groq Whisper  │         │  Ollama Cloud  │
                          │  (transcript)  │         │  (LLM summary) │
                          └────────────────┘         └────────────────┘
```

**Why frontend lives separately on Vercel:** keeps Render's free 512 MB RAM for the backend (FFmpeg-hungry) and gives the SPA a CDN edge. Next.js rewrites in [frontend/next.config.mjs](./frontend/next.config.mjs) make the browser see one origin, so cookies stay first-party (SameSite=Lax works).

**Why the worker is embedded:** Render free tier doesn't allow a separate worker service without paying. Setting `EMBED_WORKER=true` runs BullMQ inside the API process. Costs us a bit of CPU during transcode but means everything fits in one free dyno.

---

## Data model

See [backend/prisma/schema.prisma](./backend/prisma/schema.prisma) for the full source. Quick map:

```
User ───┬── memberships ──> CourseMember ──> Course ──> CourseSession ─┬─ recording (1:1) ──> SessionRecording
        ├── attendance ──> SessionAttendance ─────────────────────────┤
        ├── progress ──> SessionProgress ─────────────────────────────┤
        ├── questionsAsked / questionsAnswered ──> SessionQuestion ───┤
        └── chatMessages ──> SessionChatMessage ──────────────────────┘
                                                                       └── ownedCourses (CourseOwner)
```

Cascades: deleting a Course or Session cascades to all child rows. User cascades to all child rows except `Course.owner` (RESTRICT) and `SessionQuestion.askedBy` (RESTRICT) — preserves history if a user is removed.

A consolidated SQL dump lives at [backend/schema/schema.sql](./backend/schema/schema.sql) for DBA review or sandboxing.

### Enums
| Enum | Values | Where it ships |
|---|---|---|
| `CourseRole` | `TEACHER`, `STUDENT` | Per-membership; no global "is admin" |
| `CourseVisibility` | `PRIVATE`, `PUBLIC` | Public courses readable by non-members |
| `SessionStatus` | `DRAFT`, `SCHEDULED`, `LIVE`, `ENDED` | Lifecycle |
| `RecordingStatus` | `PENDING`, `UPLOADING`, `PROCESSING`, `READY`, `FAILED` | Pipeline |

Backend imports these from `@prisma/client`; frontend mirrors them in [frontend/lib/enums.ts](./frontend/lib/enums.ts).

---

## Key flows

### Live classroom

```
Teacher opens record page
  → preflight check (mic + screen capture)
  → MediaRecorder starts (screen + mic) → multipart upload to raw/...webm
  → publishes mediastream to mesh via setLocalStream
  → optionally clicks "Turn on camera" → adds webcam track via mesh.addLocalTrack

Student opens session
  → connects socket (JWT in cookie or sessionStorage)
  → room:join → gets participant list + initiates WebRTC connectTo each
  → renders teacher's primary stream (with audio = screen+mic) as main video
  → renders teacher's secondary stream (video-only = webcam) as PIP corner

Student raises hand
  → emit hand:raise → teacher sees ✋ in People tab + chime + toast + desktop notification
  → teacher clicks Accept
  → student is granted isPublishing
  → getUserMedia(audio+video) → mesh.setLocalStream → tracks added to teacher's pc → renegotiation
  → teacher sees student's webcam in the student grid (record page)
  → student can toggle mic / camera independently via track.enabled
  → media:toggle event syncs UI state across the room

Session ends
  → teacher stops recording
  → MediaRecorder finalizes parts → POST /complete
  → BullMQ enqueue → worker transcodes + transcribes + summarizes
  → SessionRecording.status = READY → polled in UI
```

### S3 keys
| Key | Created by | Lifetime |
|---|---|---|
| `raw/<sessionId>/<timestamp>.webm` | recording start | until course delete |
| `processed/<sessionId>/playback.mp4` | worker after transcode | until course delete |
| `processed/<sessionId>/thumb.jpg` | worker after transcode | until course delete |
| `chat/<sessionId>/<uuid>-<filename>` | chat attachment upload | until course delete |

`onDelete: Cascade` only handles DB rows. The course delete route at [backend/src/modules/courses/courses.routes.ts](./backend/src/modules/courses/courses.routes.ts) explicitly aborts in-flight multiparts + batch-deletes all keys before deleting the DB row.

---

## Repository layout

```
online-education/
├── README.md                      Setup steps for local dev
├── PROJECT-OVERVIEW.md            (this file) current-state reference
├── TECHNICAL-PLAN.md              Original planning — historical
├── docker-compose.yml             Local infra (postgres + redis + minio + optional whisper)
├── render.yaml                    Render Blueprint (olp-redis + olp-api)
├── .github/workflows/ping.yml     GitHub Actions cron pings /ping every 10 min (keep Render warm)
├── backend/
│   ├── Dockerfile                 node:20-bookworm-slim + apt openssl + ffmpeg
│   ├── prisma/
│   │   ├── schema.prisma          source of truth for DB
│   │   ├── migrations/            6 migrations, applied via `migrate deploy` on container boot
│   │   └── seed.ts                upsert demo users / courses / sessions
│   ├── schema/schema.sql          consolidated SQL (regenerated from Prisma)
│   ├── scripts/                   one-shot ops scripts (cleanup-stuck, requeue-stuck)
│   └── src/
│       ├── server.ts              entry — Express + Socket.IO + (embedded) BullMQ worker
│       ├── config.ts              env parsing
│       ├── live/                  socket handlers (rooms, hand-raise, media toggle, RTC relay)
│       ├── jobs/                  BullMQ worker, transcode, transcribe, llm
│       ├── modules/               REST routers grouped by feature
│       │   ├── auth/              login, register, demo switch
│       │   ├── courses/           course CRUD + S3 cleanup
│       │   ├── sessions/          session CRUD + attendance API
│       │   ├── recordings/        multipart init/part/complete/reset
│       │   ├── playback/          presigned URLs + watch progress
│       │   ├── memberships/       roster + invite
│       │   ├── live/              questions + chat attachments
│       │   └── storage/           thin AWS SDK wrapper
│       ├── lib/                   prisma, redis, logger, pagination, joinCode, bigint helpers
│       └── middleware/            requireAuth, requireCourseRole, rateLimit
└── frontend/
    ├── Dockerfile                 used only by docker-compose for local
    ├── next.config.mjs            standalone output + /api + /socket.io rewrites
    ├── app/                       Next.js routes (App Router)
    │   ├── (auth)/                login, register
    │   └── (app)/                 protected — courses, sessions, dashboard, record
    ├── components/
    │   ├── live/                  StudentLive, LivePanel, AttendanceSection, RemoteVideo, useLiveRoom
    │   ├── record/                Recorder, PreflightCheck
    │   ├── shell/                 Sidebar, header
    │   └── ui/                    Button, Avatar, StatusPill, Toast, Skeleton
    └── lib/                       api client, socket, rtc mesh, enums, notify
```

---

## Environment variables

### Backend (Render `olp-api`)

| Var | Source | Notes |
|---|---|---|
| `DATABASE_URL` | manual | External Postgres |
| `REDIS_URL` | auto from `olp-redis` (Blueprint) | Or paste manually |
| `JWT_SECRET` | auto-generate (Blueprint) | Or `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | static `7d` | |
| `CORS_ORIGIN` | manual | Vercel URL of frontend |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` | static `true` / `lax` | Lax works because Vercel rewrites make it same-origin |
| `S3_ENDPOINT` / `PUBLIC_S3_ENDPOINT` | manual | `https://s3.<region>.amazonaws.com` |
| `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | manual | AWS credentials |
| `S3_FORCE_PATH_STYLE` | static `false` | True only if using MinIO |
| `WHISPER_API_KEY` / `WHISPER_API_BASE_URL` / `WHISPER_MODEL` | manual / static | Default `https://api.groq.com/openai/v1` + `whisper-large-v3` |
| `WHISPER_MAX_UPLOAD_MB` | static `25` | Groq hosted limit |
| `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` | manual | Ollama Cloud + `gemma4:31b-cloud` |
| `FFMPEG_PRESET` / `FFMPEG_CRF` | static `ultrafast` / `30` | Tuned for 512 MB Render |
| `EMBED_WORKER` | static `true` | Run BullMQ in-process |
| `SEED_ON_BOOT` | static `true` (toggle off after first run) | Idempotent upsert seed |
| `LOG_LEVEL` | static `info` | |
| `NODE_ENV` / `PORT` | static `production` / `4000` | |

### Frontend (Vercel)

| Var | Notes |
|---|---|
| `BACKEND_URL` | `https://<render-url>` — server-only, used by Next rewrites |
| `NEXT_PUBLIC_API_BASE` | `/api/v1` |
| `NEXT_PUBLIC_SOCKET_URL` | `https://<render-url>` — bypasses Vercel's no-WS-proxy issue |

### GitHub Actions
- `RENDER_PING_URL` — `https://<render-url>/ping` for the keep-alive cron

---

## Demo accounts

All passwords: `demo1234`. Created by [backend/prisma/seed.ts](./backend/prisma/seed.ts).

| Email | Persona |
|---|---|
| `priya@acme.edu` | Teacher (ENG-101 + PM-305) |
| `marcus@acme.edu` | Teacher (DS-220) |
| `jae@corp.com` | Student in 2 courses |
| `lena@corp.com` | Student in 2 courses |
| `omar@corp.com` / `tess@corp.com` | Student in ENG-101 |

Seeded courses:
- `ENG-101` Technical Writing for Engineers (PRIVATE) — 8 sessions, sessions 1-4 ENDED with stub recordings
- `DS-220` Intro to Data Structures (PUBLIC)
- `PM-305` Product Management Fundamentals (PRIVATE)

Join codes printed in seed: `ENG101-JOIN`, `DS220-JOIN`, `PM305-JOIN`.

> ⚠️ The seeded session 1-4 of ENG-101 carry `playbackKey` pointing to S3 paths that don't exist. The recording rows show `READY` but clicking play returns 404. This is intentional to demo the UI state — re-record any session to get real playback.

---

## Deployment

See [render.yaml](./render.yaml) for the Blueprint. High level:

1. Push code to GitHub.
2. Render Dashboard → Blueprints → New Blueprint Instance → connect repo.
3. Render auto-creates `olp-redis` (Key Value) + `olp-api` (Web Service) in **Singapore** region.
4. Fill the 12 `sync: false` env vars in Dashboard (DB URL, S3 keys, Whisper/LLM keys, CORS origin).
5. Container boots → Dockerfile CMD runs:
   - `pnpm prisma migrate deploy` (idempotent)
   - `pnpm seed` (idempotent — set `SEED_ON_BOOT=false` after first run)
   - `node dist/server.js`
6. On Vercel, add the 3 frontend env vars and deploy from the `frontend/` directory.
7. Add `RENDER_PING_URL` repo secret on GitHub → Actions cron pings every 10 min so Render's free dyno doesn't spin down between live sessions.

---

## Operations

### Common scripts (in `backend/`)
```bash
pnpm dev              # ts-node-style dev server with watch
pnpm build            # tsc → dist/
pnpm start            # node dist/server.js
pnpm seed             # upsert demo data
pnpm prisma:generate  # regenerate Prisma client
pnpm prisma:migrate   # apply migrations to local DB
```

### One-off ops
```bash
tsx scripts/cleanup-stuck.ts   # mark UPLOADING/PROCESSING rows older than X as FAILED
tsx scripts/requeue-stuck.ts   # re-enqueue a recording that fell off the queue
```

### Regenerate consolidated SQL
```bash
cd backend
pnpm prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > schema/schema.sql
```

### Delete S3 orphans
Course delete cleans up automatically. For manual scrubbing or to hit truly orphaned objects, use AWS CLI:
```bash
aws s3 ls s3://<bucket>/raw/<sessionId>/ --recursive
aws s3 rm s3://<bucket>/raw/<sessionId>/ --recursive
```

A safer long-term fix is an S3 Lifecycle Policy that abort-s incomplete multipart uploads after 7 days and deletes `raw/*` after 30 days post-transcode.

---

## Security model

- HttpOnly + Secure cookies for the session JWT
- Cross-site Socket.IO falls back to `auth.token` from sessionStorage (cookie isn't sent cross-origin)
- `requireAuth` middleware guards every `/api/v1/*` except auth + `/health` + `/ping`
- `requireCourseRole(['TEACHER'])` / `(['TEACHER','STUDENT'])` decorates every course-scoped route
- `allowPublicRead: true` opt-in for routes that should serve PUBLIC courses to non-members
- Rate limiters on auth + demo switch
- S3 access via short-lived presigned URLs (PUT 5 min, GET 30 min)
- Bucket should reject anonymous access; only the IAM user holding the API access keys can sign URLs

---

## Known gaps / future work

- **Webcam recording-to-disk:** intentionally NOT recorded. If the teacher wants their face in the recording, that's a separate feature (split-screen layout in MediaRecorder).
- **Per-student remote mute by teacher:** not implemented. Currently teacher accepts hand → student controls own mic.
- **PTT (push-to-talk):** not implemented.
- **Multi-region S3 / failover:** out of scope for demo.
- **Pagination on attendance:** loads everything (fine for class sizes < few hundred).
- **Soft delete:** courses/sessions/recordings hard-delete on request. No "archive" / "undo".
- **Email notifications:** none. Notifications are in-app only (toast + desktop browser API).
- **Session detail page (757 lines):** flagged for split into smaller sub-components; deferred.
- **Frontend-side enum drift risk:** `frontend/lib/enums.ts` mirrors Prisma enums by hand. If Prisma changes, frontend won't catch it at build time. Consider codegen.
- **Live transcript / captions:** none. Transcripts are post-recording only.

---

## Common pitfalls (from real deploys)

| Symptom | Cause | Fix |
|---|---|---|
| `Prisma cannot find libssl.so.1.1` | Alpine base image | Use `node:20-bookworm-slim` (already in Dockerfile) |
| `ffmpeg not found` | apt didn't run / wrong base image | apt install in Dockerfile (already done) |
| `ECONNREFUSED 127.0.0.1:6379` | `REDIS_URL` not set on Render | Set manually if not using Blueprint, or recreate via Blueprint |
| `NoSuchBucket` | S3 bucket name typo / wrong region | Check actual bucket name in AWS console; update `S3_BUCKET` env |
| `not authorized to perform s3:PutObject` | IAM permissions boundary | Remove boundary OR attach `AmazonS3FullAccess` to the user |
| `The AWS Access Key Id... does not exist` | Key was deleted/rotated | Generate new keys in IAM, update env (local + Render) |
| `public.User does not exist` | Migrations not applied to prod DB | Already auto-runs via Dockerfile CMD; if push didn't deploy, force redeploy |
| Cross-site cookie not sent on socket | Vercel rewrite proxies HTTP fine but WS bypasses to direct backend (cross-origin) | Socket.IO client uses `auth.token` from sessionStorage as fallback |
| Screen picker prompts twice | React Strict Mode double-invokes effect | `reactStrictMode: false` in next.config (already disabled) |

---

## Changelog highlights

Not exhaustive — see `git log` for everything. The biggest pivots:

- **Initial scope** was record-now-watch-later. Live classroom (WebRTC) was explicitly out.
- **Live classroom shipped** — full mesh with Perfect Negotiation, raise-hand flow, in-room chat + Q&A.
- **Bidirectional A/V shipped** — students get mic + camera toggles after hand accept; teacher can opt-in to webcam (PIP for students, NOT recorded).
- **Attendance tracking shipped** — per-stint tracking, teacher report, no-show roster, crash recovery.
- **Deploy to Render + Vercel** — split, with embedded worker on free tier; Postgres external (Supabase / Neon / etc.).
- **Whisper switched** OpenAI → Groq (free tier).
- **LLM switched** OpenAI → Ollama Cloud (Gemma 4).
- **Cleanup pass** — log swallowed errors, drop verbose debug logs, replace raw role/status strings with Prisma enums end-to-end.
