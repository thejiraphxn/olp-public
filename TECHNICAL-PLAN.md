# Online Learning Platform — Demo MVP Technical Plan

Session-based teaching platform with browser screen+mic recording and later playback.

- **Stack:** Next.js (App Router) / Node.js (Express+TS) / PostgreSQL / Prisma / BullMQ + Redis / S3-compatible (MinIO for dev) / FFmpeg
- **Roles:** Teacher, Student — enforced through course-level membership, not a global user role
- **Design reference:** `design-bundle/` — indigo primary, red for live-recording, amber for processing, green for ready

---

## 1) MVP goal and boundaries

### Included
- Email/password auth + demo-persona quick-switch (for stakeholder demos)
- Course CRUD for teachers; enrollment for students
- Course membership with per-course role (`TEACHER` | `STUDENT`)
- Session CRUD inside a course with a well-defined status lifecycle
- Browser screen+audio recording (MediaRecorder API) started from the teacher session page
- Chunked upload to S3 via presigned URLs
- BullMQ worker: remux/transcode with FFmpeg → mark recording `READY`
- Student playback page with HTML5 video + chapters placeholder
- Authorization enforced by middleware at route-level AND in services

### Excluded (explicitly NOT in MVP)
- Payments / subscriptions
- Exams, quizzes, assignments, certificates
- Advanced analytics dashboards
- Multi-tenant org hierarchy
- Real-time live streaming (WebRTC / HLS low-latency) — MVP is **record now, watch later**
- Transcription, auto-chapters, auto-captions (UI hooks exist; backend is stubbed)
- Mobile native apps

### Deferred (Phase 2+, not demo)
- HLS/DASH adaptive bitrate (demo plays MP4 directly)
- Sharing links / public course pages
- Email notifications (we return success; worker logs fire the "would notify" hook)
- Magic-link auth (wired as stub; demo uses password + persona switch)
- Audit log UI (DB table exists, no admin page)

---

## 2) System architecture proposal

```
 ┌─────────────────────┐     ┌────────────────────────┐
 │  Browser (Next.js)  │────►│  API (Node/Express)    │
 │  - MediaRecorder    │     │  - REST /api/*         │
 │  - Chunk uploader   │     │  - JWT auth            │
 │  - Playback <video> │     │  - Prisma              │
 └──────────┬──────────┘     └─────┬──────────┬───────┘
            │  PUT presigned        │          │
            │  (direct to S3)       │ enqueue  │ read/write
            ▼                       ▼          ▼
     ┌──────────────┐        ┌───────────┐  ┌──────────────┐
     │ S3 / MinIO   │        │ BullMQ    │  │ PostgreSQL   │
     │ raw + hls    │◄───────│ (Redis)   │  │ (Prisma)     │
     └──────▲───────┘        └─────┬─────┘  └──────────────┘
            │                      │
            │ read/write           │ consumed by
            │                      ▼
            │              ┌────────────────┐
            └──────────────│ Worker         │
                           │ FFmpeg process │
                           └────────────────┘
```

**Frontend (Next.js App Router)**
- Server components for page shells, protected layouts, initial data fetch
- Client components for: login form, recording page (needs `navigator.mediaDevices`), upload orchestrator, video player
- Auth token held in httpOnly cookie (set by backend on login) + mirrored user profile in a client context for role checks

**Backend (Node.js + Express + TypeScript)**
- Thin REST API. Controllers → services → Prisma. Zod for request validation.
- JWT for session tokens (stateless, signed with HS256). No refresh tokens for MVP.
- Authorization helpers: `requireAuth`, `requireCourseRole(courseId, ['TEACHER'])`.
- S3 client issues presigned POST / PUT URLs; backend never proxies large uploads.

**Storage (S3 / MinIO in dev)**
- Bucket: `olp-recordings`
- Key layout:
  - `raw/{sessionId}/{uploadId}/part-{index}.webm`
  - `raw/{sessionId}/{uploadId}/final.webm` (after client posts `complete`)
  - `processed/{sessionId}/playback.mp4`

**Queue / Worker (BullMQ on Redis)**
- Queue `recording-process` — job payload `{ recordingId }`
- Concurrency 1 in dev, scale horizontally later
- Retries: 3 attempts, exponential backoff

**Media processing (FFmpeg)**
- For demo: one pass remux/transcode
  - Input: `raw/.../final.webm` (VP8/Opus from MediaRecorder)
  - Output: `processed/.../playback.mp4` (H.264 + AAC, 1080p cap, `+faststart`)
- Probe duration via `ffprobe`; persist to `SessionRecording.durationSec`
- No HLS segmentation in MVP

---

## 3) Module breakdown

Each module = one folder under `backend/src/modules/*` with `routes.ts`, `service.ts`, optional `schema.ts` (Zod).

| Module        | Responsibility                                                    |
|---------------|-------------------------------------------------------------------|
| `auth`        | register, login, logout, `/me`, demo-persona switch               |
| `users`       | user profile CRUD (read-only for demo)                            |
| `courses`     | CRUD for courses owned by the authenticated teacher               |
| `memberships` | add/remove members to a course; set per-course role               |
| `sessions`    | CRUD + status transitions under a course                          |
| `recordings`  | init upload → get presigned URLs, mark complete, poll status      |
| `playback`    | generate short-lived signed GET URLs for students                 |
| `storage`     | wraps S3 client (presign, complete multipart, delete)             |
| `jobs`        | BullMQ queue definitions + `recording-process` worker with FFmpeg |

Frontend module layout mirrors: `app/(auth)`, `app/(app)/dashboard`, `app/(app)/courses/[courseId]`, `app/(app)/courses/[courseId]/sessions/[sessionId]`, `app/(app)/courses/[courseId]/sessions/[sessionId]/record`.

---

## 4) Database planning (PostgreSQL + Prisma)

```prisma
enum CourseRole { TEACHER STUDENT }
enum SessionStatus { DRAFT SCHEDULED LIVE ENDED }
enum RecordingStatus { PENDING UPLOADING PROCESSING READY FAILED }

model User {
  id            String          @id @default(cuid())
  email         String          @unique
  name          String
  passwordHash  String
  createdAt     DateTime        @default(now())
  memberships   CourseMember[]
  ownedCourses  Course[]        @relation("CourseOwner")
}

model Course {
  id            String          @id @default(cuid())
  code          String          @unique        // e.g. ENG-101
  title         String
  description   String?
  ownerId       String
  owner         User            @relation("CourseOwner", fields: [ownerId], references: [id])
  createdAt     DateTime        @default(now())
  members       CourseMember[]
  sessions      CourseSession[]

  @@index([ownerId])
}

model CourseMember {
  id        String     @id @default(cuid())
  courseId  String
  userId    String
  role      CourseRole
  joinedAt  DateTime   @default(now())
  course    Course     @relation(fields: [courseId], references: [id], onDelete: Cascade)
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([courseId, userId])
  @@index([userId])
}

model CourseSession {
  id           String            @id @default(cuid())
  courseId     String
  course       Course            @relation(fields: [courseId], references: [id], onDelete: Cascade)
  title        String
  description  String?
  scheduledAt  DateTime?
  status       SessionStatus     @default(DRAFT)
  startedAt    DateTime?
  endedAt      DateTime?
  recording    SessionRecording?
  createdAt    DateTime          @default(now())

  @@index([courseId, scheduledAt])
}

model SessionRecording {
  id            String           @id @default(cuid())
  sessionId     String           @unique
  session       CourseSession    @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  status        RecordingStatus  @default(PENDING)
  uploadId      String?          // our own upload correlation id
  rawKey        String?          // raw/{sessionId}/{uploadId}/final.webm
  playbackKey   String?          // processed/{sessionId}/playback.mp4
  durationSec   Int?
  sizeBytes     BigInt?
  errorMessage  String?
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt
}
```

### Important indexes
- `CourseMember.@@unique([courseId, userId])` → permission checks and dedupe on invite
- `CourseMember.@@index([userId])` → "list courses I'm in" on student dashboard
- `CourseSession.@@index([courseId, scheduledAt])` → course detail "next up" query
- `SessionRecording.sessionId` → already unique; O(1) lookup

---

## 5) Permission model

**Golden rule: never derive role from `User.role`.** Always look up `CourseMember.role` for the course involved.

### Who can do what

| Action                         | Authenticated | Course TEACHER | Course STUDENT | Notes                          |
|--------------------------------|:-------------:|:--------------:|:--------------:|--------------------------------|
| Create course                  | ✓             |                |                | Creator is auto-added as TEACHER |
| Update / delete course         |               | ✓              |                |                                |
| Add / remove members           |               | ✓              |                |                                |
| Change member role             |               | ✓              |                |                                |
| Create / update / delete session|              | ✓              |                |                                |
| Start recording                |               | ✓              |                |                                |
| Stop recording / upload parts  |               | ✓              |                |                                |
| View session                   |               | ✓              | ✓              |                                |
| Watch recording                |               | ✓              | ✓              | only when `RecordingStatus = READY` |
| List their enrollments         | ✓             |                |                |                                |

### Route-level
```ts
router.post('/courses/:courseId/sessions',
  requireAuth,
  requireCourseRole('courseId', ['TEACHER']),
  sessions.create);
```

### Service-level (defence in depth)
```ts
async function startRecording({ userId, sessionId }) {
  const session = await db.courseSession.findUniqueOrThrow({ where: { id: sessionId } });
  await assertCourseRole(userId, session.courseId, ['TEACHER']);
  // ...
}
```

Two checks mean a misrouted call from an internal service still fails closed.

---

## 6) API planning (REST)

All paths prefixed with `/api/v1`. JSON in, JSON out. Auth via `Authorization: Bearer <jwt>` OR httpOnly cookie.

### Auth
| Method | Path                        | Purpose                          |
|--------|-----------------------------|----------------------------------|
| POST   | `/auth/register`            | Create account                   |
| POST   | `/auth/login`               | Returns JWT + sets cookie        |
| POST   | `/auth/logout`              | Clears cookie                    |
| GET    | `/auth/me`                  | Current user + course memberships|
| POST   | `/auth/demo/switch`         | Demo mode: log in as a persona by email (dev only) |

### Courses
| Method | Path                           | Purpose                           |
|--------|--------------------------------|-----------------------------------|
| GET    | `/courses`                     | List courses I own or belong to   |
| POST   | `/courses`                     | Create (teacher)                  |
| GET    | `/courses/:id`                 | Detail                            |
| PATCH  | `/courses/:id`                 | Update (owner/teacher)            |
| DELETE | `/courses/:id`                 | Delete (owner)                    |

### Members
| Method | Path                                              | Purpose                |
|--------|---------------------------------------------------|------------------------|
| GET    | `/courses/:id/members`                            | List                   |
| POST   | `/courses/:id/members`                            | Add by email + role    |
| PATCH  | `/courses/:id/members/:userId`                    | Change role            |
| DELETE | `/courses/:id/members/:userId`                    | Remove                 |

### Sessions
| Method | Path                                              | Purpose                |
|--------|---------------------------------------------------|------------------------|
| GET    | `/courses/:id/sessions`                           | List                   |
| POST   | `/courses/:id/sessions`                           | Create                 |
| GET    | `/courses/:id/sessions/:sessionId`                | Detail (incl. recording)|
| PATCH  | `/courses/:id/sessions/:sessionId`                | Update                 |
| DELETE | `/courses/:id/sessions/:sessionId`                | Delete                 |

### Recordings (teacher)
| Method | Path                                                                   | Purpose                                    |
|--------|------------------------------------------------------------------------|--------------------------------------------|
| POST   | `/courses/:id/sessions/:sessionId/recordings`                          | Init: create recording row, return uploadId |
| POST   | `/courses/:id/sessions/:sessionId/recordings/:recordingId/part-url`    | Get presigned PUT URL for chunk index N     |
| POST   | `/courses/:id/sessions/:sessionId/recordings/:recordingId/complete`    | Mark upload complete → enqueue processing   |
| GET    | `/courses/:id/sessions/:sessionId/recordings/:recordingId`             | Get status                                  |

### Playback (student + teacher)
| Method | Path                                                              | Purpose                                 |
|--------|-------------------------------------------------------------------|-----------------------------------------|
| GET    | `/courses/:id/sessions/:sessionId/playback`                       | Returns `{ url, expiresAt, duration }`  |

---

## 7) Frontend page planning (Next.js App Router)

| Route                                                                   | Who         | Purpose                                       |
|-------------------------------------------------------------------------|-------------|-----------------------------------------------|
| `/`                                                                     | any         | Redirect to /login or /dashboard              |
| `/login`                                                                | anon        | Demo persona picker + email/password form     |
| `/dashboard`                                                            | auth        | Dispatches to teacher or student view         |
| `/courses`                                                              | auth        | List — teachers see own+enrolled, students see enrolled |
| `/courses/new`                                                          | teacher     | Create course                                 |
| `/courses/[courseId]`                                                   | auth        | Course detail: sessions tab (table), members tab, recordings tab |
| `/courses/[courseId]/members`                                           | teacher     | Member management                             |
| `/courses/[courseId]/sessions/new`                                      | teacher     | Create session                                |
| `/courses/[courseId]/sessions/[sessionId]`                              | auth        | Student playback view (or teacher read view)  |
| `/courses/[courseId]/sessions/[sessionId]/record`                       | teacher     | Recording studio                              |

A single `(app)` route group wraps everything behind the sidebar+topbar shell. Layout does auth check server-side and redirects to `/login` if missing.

---

## 8) Recording workflow

```
Teacher                          Browser                     Backend                    S3/MinIO
────────                         ────────                    ────────                   ────────
clicks "Start recording"
                                 getDisplayMedia()+getUserMedia()
                                 merge tracks → MediaRecorder
                                 POST /recordings (init)
                                 ─────────────────────────►  create SessionRecording
                                                             status=UPLOADING
                                                             return {recordingId, uploadId}
                                 ◄─────────────────────────
                                 timeslice = 5s
                                 ondataavailable(chunk0)
                                 POST /part-url?index=0
                                 ─────────────────────────►  s3.createPresignedPut(key)
                                 ◄─────────────────────────
                                 PUT chunk0 ─────────────────────────────────────────►  part-0.webm
                                 (repeat for chunk1..N)
clicks "Stop"                    recorder.stop()
                                 POST /complete {count}
                                 ─────────────────────────►  concatenate parts → final.webm
                                                             recording.rawKey = ...
                                                             recording.status = PROCESSING
                                                             queue.add('recording-process', {recordingId})
                                 ◄─────────────────────────
 sees "Processing..."            polls GET /recordings/:id every 5s
                                                             worker picks up job
                                                             ffmpeg -i final.webm ... playback.mp4
                                                             recording.playbackKey = ...
                                                             recording.status = READY
 sees "Ready"
```

### Why chunked / presigned
- Large recordings (30–90 min) can exceed single-request upload limits
- Recovery possible: on network blip, resume from last successful chunk index
- Zero backend CPU on upload path; S3 does the work

### Finalizing parts
- MVP simplification: use S3 **multipart upload** (`CreateMultipartUpload` → presigned PUT per part → `CompleteMultipartUpload`) so S3 does the concatenation server-side. No FFmpeg concat step needed.
- Each browser chunk maps to one S3 part (min 5MB except last). Buffer chunks client-side until ≥5MB then flush a part.

### Playback readiness
A recording becomes `READY` when:
1. All parts uploaded and S3 multipart completed → `rawKey` set
2. FFmpeg transcode succeeded → `playbackKey` set
3. `ffprobe` returned duration → `durationSec` set

Any failure in 1–3 → `FAILED` with `errorMessage`. Retry is manual via UI button calling `POST .../complete` again (which re-enqueues).

---

## 9) Background jobs / processing flow

### Queue: `recording-process`
Triggered by: `POST /recordings/:id/complete`
Payload: `{ recordingId: string }`
Worker steps:
1. Load `SessionRecording`; guard `status === UPLOADING`. Set `PROCESSING`.
2. Download `rawKey` from S3 to `/tmp/{uuid}.webm` (stream).
3. `ffprobe` → extract duration.
4. `ffmpeg -i input.webm -c:v libx264 -preset veryfast -crf 23 -vf scale=-2:min(1080\,ih) -c:a aac -b:a 128k -movflags +faststart output.mp4`
5. Upload `output.mp4` to `processed/{sessionId}/playback.mp4`.
6. Update recording row: `playbackKey`, `durationSec`, `sizeBytes`, `status = READY`.
7. On any throw → `status = FAILED`, `errorMessage = err.message`.

### Optional stubs (logged, not executed in MVP)
- Thumbnail at 5s → `processed/{sessionId}/thumb.jpg`
- Auto-chapter detection (silence/scene-cut) — placeholder function, returns [] in MVP

### "Ready" definition
UI treats `status === READY && playbackKey` as the single source of truth. Until then, the playback page shows the "processing" design.

---

## 10) Phased roadmap

### Phase 0 — Foundation (0.5 day)
- **Objective:** repo structure, tooling, docker-compose bring-up
- **Tasks:** mono-repo layout, `docker-compose.yml` (postgres, redis, minio), `.env.example`, Prisma init, Next.js + Tailwind init, shared palette tokens
- **Outputs:** `docker compose up` gives you Postgres+Redis+MinIO; `pnpm --filter backend dev` and `pnpm --filter frontend dev` both boot
- **Dependencies:** none
- **Risk:** MinIO ↔ S3 SDK signing mismatch → pin `aws-sdk` v3 and set `forcePathStyle: true`

### Phase 1 — Auth + role model (0.5 day)
- **Objective:** log in, know who you are
- **Tasks:** User table + password hashing (bcrypt), JWT, `/me`, login page, protected layout, demo-persona switch endpoint, seed 2 teachers + 4 students
- **Outputs:** Demo login screen fully working
- **Dependencies:** Phase 0
- **Risk:** JWT in cookie + CORS when ports differ → set `credentials: true` and `sameSite=lax` on dev

### Phase 2 — Courses + membership (0.5 day)
- **Objective:** teachers create courses, add students
- **Tasks:** `courses` + `memberships` modules, course list page, course detail shell with tabs, member management page, `requireCourseRole` middleware
- **Outputs:** All non-recording CRUD working; student can see courses they're in
- **Dependencies:** Phase 1
- **Risk:** forgetting to auto-add the creator as TEACHER → always do it inside a transaction in `courses.create`

### Phase 3 — Session management (0.5 day)
- **Objective:** sessions under courses, state lifecycle wired
- **Tasks:** `sessions` module, create/edit/delete, session list in course detail (table), status pill component
- **Outputs:** Teacher can plan sessions; student sees them with correct status
- **Dependencies:** Phase 2
- **Risk:** status transitions implicit in too many places → centralize in `sessions.service.updateStatus`

### Phase 4 — Recording MVP (1.5 days — highest risk)
- **Objective:** Start/stop recording, upload, save metadata
- **Tasks:**
  - Browser recorder (MediaRecorder, screen+mic track merge)
  - Buffered chunk-to-part flusher (≥5MB)
  - S3 multipart init / PUT per part / complete wired through backend
  - Recording studio UI (V1 Studio from wireframes)
  - Upload progress + retry UI
- **Outputs:** Teacher records a 2-minute session end-to-end, raw file lands in MinIO
- **Dependencies:** Phase 3, MinIO working
- **Risk:** codec — MediaRecorder default `video/webm;codecs=vp8,opus`; confirm browser support; test in Chrome first, document Safari gap

### Phase 5 — Playback MVP (0.5 day)
- **Objective:** Process + watch
- **Tasks:** BullMQ worker, FFmpeg transcode, signed GET URL endpoint, student playback page (V2 chapters+transcript), processing placeholder (V4 not-ready)
- **Outputs:** Recording flips PENDING → PROCESSING → READY; student watches MP4
- **Dependencies:** Phase 4
- **Risk:** FFmpeg binary not on PATH in worker container → bundle `ffmpeg-static` and set binary path explicitly

### Phase 6 — Polish & demo prep (0.5 day)
- **Objective:** One coherent 3-minute demo
- **Tasks:** Seed data that matches demo script (Priya/Jae-won), hotkeys, empty states, loading skeletons, dashboard "continue watching" (V1 student), error states
- **Outputs:** Demo script + recording of it
- **Dependencies:** Phases 1–5
- **Risk:** live demos crash — pre-record a backup video of a happy-path run

---

## 11) Demo-first priorities

If the only goal is **"ship a convincing 3-minute demo"**, build in this exact order and you will have a working demo within ~3 days:

1. **Auth + demo personas** (Phase 1) — skip real signup; 4 pre-seeded users visible on the login screen. One click, you're in.
2. **Teacher dashboard + course detail + session list** — hard-code the seeded ENG-101 so the UI feels lived-in from second 0.
3. **Start recording → stop recording → "processing"** — the pixel-perfect V1 Studio screen with the red recording pill and timer is the demo's money shot. Build it before chunked upload works end-to-end; fake the upload in UI first so the screen is right.
4. **End-to-end recording upload + FFmpeg worker** — wire the real plumbing behind the UI you just shipped.
5. **Student playback page (V2 chapters)** — switch persona to Jae-won in the same browser tab, open the same session, hit play.
6. **"Not ready" state** — short-circuits the demo failure where transcode takes too long.

Everything else — member invite, course settings, kanban view, focus mode, magic link — is explicitly **cut** for the first demo.

---

## 12) Risk & simplification strategy

| Risk                                                                 | Simplification for MVP                                                         |
|----------------------------------------------------------------------|---------------------------------------------------------------------------------|
| Browser codec fragmentation (Safari vs Chrome)                       | Demo on Chrome; document this as a known MVP limit; pass `mimeType: 'video/webm;codecs=vp8,opus'` |
| Screen + mic permissions flow varies across OS                       | Pre-flight screen (V3) explicitly requests both permissions and shows status   |
| Large-file upload reliability                                        | Use S3 multipart with per-part retries; track `lastCompletedPartIndex` client-side |
| FFmpeg transcode is slow on small instances                          | For demo, cap input to 1080p30, use `preset=veryfast`, CRF 23                  |
| Long processing makes demo awkward                                   | Show the "processing" screen as a feature, not a bug; seed a pre-transcoded recording so student side is always READY |
| Storing tokens in localStorage → XSS risk                            | Use httpOnly cookies, `sameSite=lax`, set via backend on login                 |
| `CourseMember` vs `User.role` drift causes privilege escalation      | `User` has no `role` column at all. Role is always fetched per course.         |
| Worker crashes mid-job → recording stuck in PROCESSING               | BullMQ default retry + `stalled` check; on final failure set `FAILED` with error |
| Demo without internet                                                | MinIO runs locally; everything (including S3) is offline-capable               |
| Presigned URLs leak in logs                                          | Never log URLs; only log the key                                               |
| Scope creep toward Zoom/live streaming                               | State it up front — "record now, watch later" — and refuse live streaming requests in MVP |

---

## Appendix A — Environment variables

### backend/.env
```
DATABASE_URL=postgresql://olp:olp@localhost:5432/olp
REDIS_URL=redis://localhost:6379
JWT_SECRET=dev-only-change-me
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:3000
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=olp-recordings
S3_FORCE_PATH_STYLE=true
PUBLIC_S3_ENDPOINT=http://localhost:9000
```

### frontend/.env.local
```
NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1
```

## Appendix B — Running it

```
docker compose up -d        # postgres, redis, minio + bucket init
cd backend && pnpm install && pnpm prisma migrate dev && pnpm seed
cd backend && pnpm dev       # API on :4000
cd backend && pnpm worker    # separate terminal for worker
cd frontend && pnpm install && pnpm dev    # Next.js on :3000
```
