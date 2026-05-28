# Major Refactor — Tasks

> Goal: deprecate Redis/BullMQ, move task orchestration into Postgres, push transcribe + summarize work to Python (whisper-server), and re-shape the Node backend into Clean Architecture.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Phase 0 — Planning artifacts

- [x] `task.md` (this file)
- [x] `skill.md` (working patterns + conventions)

---

## Phase 1 — Task subsystem on Postgres (replace Redis/BullMQ)

### 1.1 Schema

- [x] Add `TaskStatus` enum: `PENDING`, `CLAIMED`, `TRANSCODING`, `EXTRACTING_AUDIO`, `UPLOADING_AUDIO`, `THUMBNAIL`, `HANDED_OFF`, `TRANSCRIBING`, `SUMMARIZING`, `COMPLETED`, `FAILED`, `CANCELED`
- [x] Add `TaskType` enum: `RECORDING_PIPELINE`
- [x] Add `Task` model with indexes on `(status, lockedUntil)`, `recordingId`, `createdAt`
- [x] Add `audioKey String?` to `SessionRecording`
- [x] Migration `20260506112356_add_task_table_and_audio_key` applied locally

### 1.2 Domain + ports — DONE

- [x] `domain/entities/Task.ts` — Task type + TaskStatus/TaskType unions + TaskLogEntry + isTerminal() helper
- [x] `domain/entities/Recording.ts` — Recording, TranscriptSegment, Chapter types
- [x] `domain/ports/TaskRepository.ts` — create / claimNext (FOR UPDATE SKIP LOCKED contract) / heartbeat / updateStatus / appendLog / markCompleted / recordFailure / cancel / findById / list
- [x] `domain/ports/StorageGateway.ts` — putObjectFromFile / downloadToFile / presignGet/Put / delete + multipart helpers
- [x] `domain/ports/MediaPipeline.ts` — transcodeToMp4 / extractAudioMp3 / extractThumbnailJpeg / probeDurationSec
- [x] `domain/ports/WhisperGateway.ts` — enqueueTranscription({taskId, audioFile, language?})

### 1.3 Application use-cases — DONE

- [x] Added 3 more ports: `RecordingRepository`, `TranscribeGateway` (Phase-1-only), `SummarizeGateway` (Phase-1-only), `Workspace` (filesystem abstraction)
- [x] `application/shared/log.ts` — `makeLogEntry()` helper
- [x] `application/recordings/CompleteRecording.ts` — idempotent multipart completion + Task creation
- [x] `application/recordings/RetryRecording.ts` — clear errorMessage + new Task
- [x] `application/tasks/ProcessRecordingTask.ts` — full pipeline orchestrator with idempotency gates per stage (TRANSCODING → THUMBNAIL → EXTRACTING_AUDIO → UPLOADING_AUDIO → TRANSCRIBING → SUMMARIZING → COMPLETED)
- [x] `application/tasks/ListTasks.ts` — paginated list for admin UI
- [x] `application/tasks/RetryTask.ts` — admin: requeue a task
- [x] `application/tasks/CancelTask.ts` — admin: cancel non-terminal task
- ~~ClaimNextTask~~ → moved into `TaskRepository.claimNext` (it's a port concern, not a use-case)

### 1.4 Infrastructure — DONE

- [x] `infrastructure/db/PrismaTaskRepository.ts` — claimNext uses CTE + `FOR UPDATE SKIP LOCKED`. recordFailure increments attempts inside a tx and either requeues (PENDING) or fails (FAILED). appendLog caps at 200 entries.
- [x] `infrastructure/db/PrismaRecordingRepository.ts`
- [x] `infrastructure/storage/S3Storage.ts` — wraps S3 SDK; takes 2 clients (internal + publicForSigning) so presigned URLs sign with the public hostname
- [x] `infrastructure/media/FfmpegMediaPipeline.ts` — transcode (with simple-fallback), extractAudioMp3, extractThumbnailJpeg, probeDurationSec
- [x] `infrastructure/whisper/HttpTranscribeGateway.ts` — Phase-1 sync wrapper around Whisper API (deleted in Phase 2)
- [x] `infrastructure/llm/HttpSummarizeGateway.ts` — Phase-1 sync wrapper around LLM (deleted in Phase 2)
- [x] `infrastructure/workspace/OsTmpWorkspace.ts` — node:fs mkdtemp impl
- [x] `infrastructure/tasks/TaskHandler.ts` — handler interface + registry type
- [x] `infrastructure/tasks/handlers/RecordingPipelineHandler.ts` — wraps ProcessRecordingTask use-case
- [x] `infrastructure/tasks/TaskWorker.ts` — polling loop (2s default), 60s lease, 20s heartbeat, graceful shutdown waits up to 5min for in-flight task

> Phase 2 fire-and-forget WhisperGateway impl is deferred to Phase 2 (Python-owns flow). Phase 1 uses `HttpTranscribeGateway` instead.

### 1.5 Wire-up + delete legacy — DONE

- [x] `composition.ts` (composition root) — `buildContainer()` wires adapters → use-cases → TaskWorker; exports `getContainer(req)` accessor
- [x] `server.ts` — uses `buildContainer()` once at boot, mounts `tasks.routes.ts`, starts TaskWorker, graceful shutdown calls `worker.stop()`
- [x] `recordings.routes.ts` — `/complete` and `/retry` use new use-cases; other endpoints unchanged (will move in 2.5)
- [x] `tasks.routes.ts` (new) — admin REST: list/get/retry/cancel
- [x] **DELETED** `lib/redis.ts`, `jobs/queue.ts`, `jobs/worker.ts`, `jobs/llm.ts`, `jobs/transcribe.ts`, `modules/admin/queue.routes.ts`, `scripts/cleanup-stuck.ts`, `scripts/requeue-stuck.ts`
- [x] **REMOVED deps**: `ioredis`, `bullmq`, `@bull-board/api`, `@bull-board/express`
- [x] **REMOVED `redis` service** from `docker-compose.prod.yml` + `docker-compose.yml`
- [x] **REMOVED REDIS_URL** from `config.ts`, `.env.example`, `render.yaml`, both compose files
- [x] **REMOVED `worker` script** from `backend/package.json`
- [x] Updated Dockerfile + DEPLOY.md to reflect Postgres-backed worker
- [x] Updated frontend Sidebar — Worker link points to `/admin/tasks` (page comes in 1.6)

> Route handlers in `recordings.routes.ts` still mix prisma-direct calls with use-cases for non-Phase-1 paths (init/abort/reset/chapters/summary). Full route refactor is deferred to Phase 2.5 to keep this slice small.

### 1.6 Admin task API + UI — DONE

- [x] `GET /api/v1/admin/tasks` — list with filter (status[]), keyset pagination
- [x] `GET /api/v1/admin/tasks/:id` — full record + logs[]
- [x] `POST /api/v1/admin/tasks/:id/retry` — RetryTask use-case
- [x] `POST /api/v1/admin/tasks/:id/cancel` — CancelTask use-case (with reason)
- [x] Frontend `app/(app)/admin/tasks/page.tsx` — list + filter tabs (All/Active/Failed/Completed) + retry/cancel + auto-refresh 5s
- [x] Frontend `app/(app)/admin/tasks/[taskId]/page.tsx` — detail + logs table + auto-poll while non-terminal
- [x] `frontend/lib/taskStatus.ts` — TaskStatus union mirroring backend, label + badge-kind maps, isTerminalTaskStatus
- [x] `frontend/components/tasks/TaskBadge.tsx` — color-coded badge with spinner for active stages, retry counter, errorMessage tooltip
- [x] Backend `playback.routes.ts` — includes `task` block + `audioUrl` (presigned mp3 download) in response
- [x] Session detail page — TaskBadge rendered next to StatusPill
- [x] Sidebar Worker entry → `/admin/tasks` (in-app navigation)

---

## Phase 2 — Python whisper-server takes over downstream

### 2.1 New endpoint + DB connection — DONE

- [x] `whisper-server/requirements.txt`: added `sqlalchemy[asyncio]==2.0.36`, `asyncpg==0.29.0`, `httpx==0.27.2`, `python-dotenv==1.0.1`
- [x] `whisper-server/db.py` — async engine (asyncpg driver, accepts `postgresql://` and `postgresql+asyncpg://` flavors), session_scope context manager
- [x] `whisper-server/tasks.py` — raw-SQL helpers (uses `text()` not ORM models — keeps schema flexibility): set_status, append_log, mark_completed/failed, save_transcript/auto_summary/auto_chapters; TaskStatus constants mirror the Prisma enum
- [x] `whisper-server/logger_setup.py` — RotatingFileHandler → `app.log` (10 MB × 5) + console
- [x] `whisper-server/llm.py` — async httpx client, summarize + generate_chapters, JSON parsing of LLM reply, model defaults to llama-3.3-70b-versatile
- [x] `whisper-server/server.py` major rewrite:
  - `POST /v1/tasks` (multipart: file + task_id + language?) → buffers to temp → 202 → BackgroundTasks
  - Background flow: TRANSCRIBING → save_transcript → SUMMARIZING → save_auto_summary + save_auto_chapters (parallel) → mark_completed
  - Catch-all: mark_failed + log + cleanup temp file in finally
  - Verifies task exists in DB before accepting work
- [x] Legacy `POST /v1/audio/transcriptions` kept (marked `deprecated=True`) for ad-hoc tooling
- [x] `.env.example` extended — DATABASE_URL, LLM_*, APP_LOG_*

### 2.2 Ollama in Python (deprecate Node LLM) — DONE

- [x] `whisper-server/llm.py` — full client (Groq / Ollama Cloud / etc.) with timeout via httpx
- [x] **DELETED** `backend/src/domain/ports/TranscribeGateway.ts`
- [x] **DELETED** `backend/src/domain/ports/SummarizeGateway.ts`
- [x] **DELETED** `backend/src/infrastructure/whisper/HttpTranscribeGateway.ts`
- [x] **DELETED** `backend/src/infrastructure/llm/HttpSummarizeGateway.ts` (and its `infrastructure/llm/` directory)
- [x] **CREATED** `backend/src/infrastructure/whisper/HttpWhisperGateway.ts` — fire-and-forget multipart POST to `/v1/tasks` (returns on 202)
- [x] Refactored `application/tasks/ProcessRecordingTask.ts` — Node now drives only TRANSCODING → THUMBNAIL → EXTRACTING_AUDIO → UPLOADING_AUDIO → HANDED_OFF, then `whisper.enqueueTranscription()` + `releaseLock()`. Python finalizes status to COMPLETED.
- [x] Added `TaskRepository.releaseLock(taskId)` + Prisma impl
- [x] `claimNext` excludes Python-owned statuses (`HANDED_OFF`, `TRANSCRIBING`, `SUMMARIZING`) so Node workers don't race with Python on retries
- [x] `TaskWorker` no longer auto-markCompleted — handler is responsible for finalizing (markCompleted or releaseLock+HANDED_OFF)
- [x] `composition.ts` rewired — drop transcribe/summarize, wire `HttpWhisperGateway`
- [x] `docker-compose.prod.yml` — removed `LLM_*` from api service; added `WHISPER_HANDOFF_TIMEOUT_MS`
- [x] `.env.production.example` — replaced LLM_* block with note that LLM env now belongs to whisper-server

### 2.3 UI status badge per recording — DONE (delivered as part of Phase 1.6)

- [x] Backend: include `task` in `GET /sessions/:id/playback` response → `{ status, attempts, lastLog, errorMessage }`
- [x] Frontend: `<TaskBadge>` component in `components/tasks/`
  - Status → label + color:
    - PENDING → "Queued" (slate)
    - CLAIMED → "Starting" (slate)
    - TRANSCODING → "Encoding video" (warn)
    - EXTRACTING_AUDIO → "Extracting audio" (warn)
    - UPLOADING_AUDIO → "Saving audio" (warn)
    - THUMBNAIL → "Thumbnail" (warn)
    - HANDED_OFF → "Handed to whisper" (accent)
    - TRANSCRIBING → "Transcribing" (accent)
    - SUMMARIZING → "Generating summary" (accent)
    - COMPLETED → "Ready" (ok)
    - FAILED → "Failed" (live, with errorMessage tooltip)
    - CANCELED → "Canceled" (slate)
- [x] Render badge on session detail page (next to StatusPill)
- [ ] Render badge on course session list rows ← **deferred** (low priority)
- [ ] Render badge on record page during processing ← **deferred** (recorder UI already shows its own state)
- [x] Auto-poll while non-terminal — `/admin/tasks` polls every 5s, detail page every 3s

### 2.4 Guest live participation parity + teacher-only /record — DONE

- [x] Schema migration `allow_guest_chat_and_questions`:
  - `SessionChatMessage.userId` → nullable; added `guestName String?`
  - `SessionQuestion.askedByUserId` → nullable; added `askedGuestName String?`
- [x] `live/server.ts` socket handlers — removed `if (isGuest) return` early-drop on `chat:send` + `question:ask`; guests now write rows with `userId=null`/`askedByUserId=null` + the guest display name
- [x] `live/server.ts` `question:answer` emit — fall back to `askedGuestName` when `askedBy` is null
- [x] `live/types.ts` — `Question.askedByUserId: string | null`
- [x] `modules/live/questions.routes.ts` GET — handle null `askedBy` with guest fallback
- [x] `modules/live/questions.routes.ts` POST — added `allowPublicRead: true`; writes guest rows correctly
- [x] `modules/live/uploads.routes.ts` POST `/init` — added `allowPublicRead: true` so guests can attach files
- [x] `modules/live/uploads.routes.ts` GET `/messages` — flatten `userName` w/ guestName fallback for the wire
- [x] Frontend `/record` page — explicit role check on mount: non-teacher redirected to session detail with toast
- [x] Backend `requireCourseRole(['TEACHER'])` already present on every recording write endpoint (verified)

> Hand-raise / attendance: hand-raise had no guest gate already (works); attendance is intentionally skipped for guests (see `live/server.ts:233`) — that matches "guest = anonymous viewer" semantics.

### 2.5 Clean Architecture restructure

- [ ] Folder layout (target):
  ```
  backend/src/
  ├── domain/
  │   ├── entities/         # plain TS classes / types, no framework
  │   └── ports/            # interfaces only
  ├── application/
  │   ├── auth/
  │   ├── courses/
  │   ├── recordings/
  │   ├── tasks/
  │   ├── live/
  │   └── shared/           # cross-cutting use-case helpers
  ├── infrastructure/
  │   ├── db/               # Prisma repos
  │   ├── storage/          # S3 impl
  │   ├── media/            # ffmpeg impl
  │   ├── whisper/          # Python gateway
  │   ├── live/             # Socket.IO server impl
  │   └── tasks/            # TaskWorker + handlers
  ├── interfaces/
  │   ├── http/             # Express routers, request DTOs, error mapping
  │   └── socket/           # Socket.IO event handlers
  ├── config.ts             # env loader (kept simple)
  └── main.ts               # composition root
  ```
- [ ] **Layering rule:** domain ← application ← infrastructure ← interfaces. Inner layers must not import outer ones. Enforce via lint rule (eslint-plugin-boundaries) — config later.
- [ ] Refactor incrementally: start with `recordings` slice (since it's most affected by Phase 1), then `auth`, then `courses`, then `live`. Don't big-bang.

---

## Acceptance criteria

### Phase 1 acceptance
- [x] `docker compose -f docker-compose.prod.yml ps` shows no `redis` service ← config side done; runtime test pending
- [x] `pnpm list` in backend shows no `ioredis` / `bullmq` / `bull-board` ← deps removed
- [ ] Recording a 1-min clip end-to-end produces a row in `Task` with `status=COMPLETED` and `recording.playbackKey` + `recording.audioKey` filled ← runtime test pending
- [x] Admin task UI lists the task, shows logs, shows retry button ← page built; runtime test pending

### Phase 2 acceptance
- [x] LLM_* env vars present only in `whisper-server/.env`, removed from Node config
- [ ] After Node hands off the audio, `journalctl -u whisper-server` shows `transcribe → summarize → done` and `Task.status` ends at `COMPLETED` ← **runtime test pending**
- [x] `app.log` rotating handler wired in whisper-server
- [ ] If LLM is down, `Task.status=FAILED`, `errorMessage` populated, video still plays ← **runtime test pending**
- [x] Guest user can send chat + ask question in a live session
- [x] Non-teacher hitting `/courses/:id/sessions/:sid/record` is redirected with a toast
- [ ] All `domain/` files have zero imports outside `domain/` ← Phase 2.5 audit
- [ ] All `application/` files import only from `domain/` and `application/` ← Phase 2.5 audit

---

## Notes / open questions

- **mp3 format:** keep current `64k mono 16k mp3` (≈28 MB / hour) — good enough for whisper, small for download.
- **Audio download URL:** add `audioKey` to playback response and gate behind `requireSessionAccess`. Same flow as mp4.
- **mp3 handoff to Python:** Node sends mp3 bytes via multipart/form-data POST (same shape as today's `/v1/audio/transcriptions`). Python writes to its own temp file, processes, deletes in `finally`. **Python does NOT have S3 credentials.** The mp3 in MinIO (`audioKey`) is for teacher/student download UI only — Python never reads from S3.
- **Fire-and-forget call to Python:** Node uses `fetch(..., {dispatcher: short-timeout-agent})` — only needs to confirm 202 Accepted within ~5s. Python owns everything after.
- **Polling interval:** 2s for the worker. Frontend polls `/playback` every 4s only while task is non-terminal.
- **Lease length:** 60s. Heartbeat every 20s. If worker dies, lock auto-expires and another worker picks up.
- **Failure escalation:** after `attempts >= maxAttempts (3)`, status=FAILED. No exponential backoff in v1 (keep it simple).
- **Migration order matters:** Phase 1 ships fully first → verify Postgres-based pipeline works → then Phase 2 moves transcribe/summarize to Python. Don't merge them.
