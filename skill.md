# Skill / Working Patterns

> Conventions for working in this repo. Read this before opening a new conversation about the project.

---

## Architecture

### Backend: Clean Architecture (target after Phase 2)

```
domain        ← entities, value objects, port interfaces. Zero framework deps.
application   ← use-cases. Orchestrate domain via ports. Depends only on domain.
infrastructure← concrete adapters: Prisma, S3, ffmpeg, HTTP clients. Implements ports.
interfaces    ← Express routes + Socket.IO. Calls application use-cases. Translates HTTP ↔ domain.
main.ts       ← composition root. Wires repos + use-cases + servers.
```

**Layering rule (strict):**
- `domain/*` → no imports outside `domain/`
- `application/*` → imports `domain/` only (no Express, Prisma, S3, ffmpeg, fetch, etc.)
- `infrastructure/*` → imports `domain/` + `application/`. Implements ports.
- `interfaces/*` → imports `application/` use-cases. Thin: parse → call → respond.

When tempted to import Prisma in `application/`: stop, make a port in `domain/ports/` and an adapter in `infrastructure/db/`.

### Where work goes

| Concern | Layer | Example |
|---|---|---|
| Business rule (e.g. "completed recording must have both playbackKey + audioKey") | domain or application | `Recording.markComplete()` |
| HTTP shape (request body, response JSON) | interfaces | `recordings.routes.ts` DTOs |
| DB query | infrastructure | `PrismaRecordingRepository.findById` |
| ffmpeg invocation | infrastructure | `FfmpegMediaPipeline.transcode` |
| Validation | interfaces (zod) + domain (invariants) | both layers |

### Frontend: feature-folder, no clean architecture overkill

Next.js App Router. Keep it pragmatic:
- `app/` route segments
- `components/` per-feature (recordings, live, ui)
- `lib/` cross-cutting helpers (api client, dialog, enums, format)

Don't introduce ports/adapters in the frontend.

---

## Task subsystem (Postgres-backed, replaces BullMQ)

- Single `Task` table with `status` + `lockedBy`/`lockedUntil`
- Worker loops: `SELECT … WHERE status='PENDING' AND (lockedUntil IS NULL OR lockedUntil < now()) ORDER BY createdAt LIMIT 1 FOR UPDATE SKIP LOCKED`
- Heartbeat: while running, refresh `lockedUntil = now() + 60s` every 20s
- Append logs to `Task.logs` JSONB array — never overwrite, always append. Cap at e.g. 200 entries.
- On failure: increment `attempts`. If `attempts >= maxAttempts`, set `status=FAILED`. Otherwise reset to `PENDING` for another claim.
- Graceful shutdown: SIGTERM → release locks → exit. The Express server should not exit before the worker drains.

**Why Postgres not Redis:** one less moving part, better visibility (rows are queryable), durability without Redis persistence config, transactional with the rest of the app.

---

## Python whisper-server

- Owns transcribe + summarize. Calls back to Postgres directly (does NOT call Node).
- Uses `BackgroundTasks` for the long path so HTTP POST returns 202 immediately.
- Logs to `app.log` (rotating, 10 MB × 5) **and** stdout. Every state change also appends to `Task.logs` so the UI sees it.
- Failures: `Task.status=FAILED`, `Task.errorMessage` populated, `Recording.status` stays whatever it was (the video itself is still playable).
- Cleans up temp files in `finally`.

**LLM lives only in Python.** Node has no Ollama client after Phase 2.

---

## Conventions

### TypeScript
- Strict mode on. Don't add `any` to silence — model the type or use `unknown`.
- Prefer named exports. Default exports only for Next.js pages and React components consumed by router.
- `import type` for type-only imports.

### Comments
- Default to none. Add only when the **why** is non-obvious — a hidden constraint, a workaround, a counterintuitive choice.
- Don't restate the code. Don't reference the current task or commit.
- One line max for inline. Multi-line only when explaining a non-obvious invariant.

### Error handling
- Validate at boundaries (interfaces layer, with zod). Trust internal calls.
- Don't swallow errors. Log with structured context (`logger.error({ err, taskId }, 'msg')`).
- For non-fatal post-process errors (e.g. Ollama 500 after transcript saved), record on the row's `errorMessage` but don't fail the whole pipeline.

### File size
- Soft cap 500 lines per file. Past 500, ask: is this one cohesive unit, or two?
- Worker handlers, routes, and use-cases are usually small (< 100 lines). When they grow, extract helpers.

### Testing
- Use vitest in backend (already in deps). Tests live in `__tests__/` next to source or `tests/` at root.
- Test use-cases in isolation with in-memory port implementations. No Prisma in unit tests.
- Smoke tests in `tests/auth.test.ts` style — keep at least one happy-path per major flow.

### Migrations
- One migration per logical change. Don't batch unrelated schema edits.
- Name format: `YYYYMMDDHHMMSS_short_snake_case.sql`
- Migrations are immutable. To revert, write a new migration that undoes.
- Always include comments at the top of `.sql` files explaining intent (especially when adding columns, since `prisma migrate dev` autogenerates and won't add why).

---

## Commands

### Day-to-day
```bash
# Backend dev (with hot reload + worker)
cd backend && pnpm dev

# Frontend dev
cd frontend && pnpm dev

# Whisper server (after venv activated)
cd whisper-server && python server.py

# Typecheck
cd backend && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```

### Database
```bash
# After schema.prisma change → create migration
cd backend && pnpm prisma migrate dev --name <description>

# Production deploy (runs auto on api container boot)
pnpm prisma migrate deploy
```

### Deploy (VPS)
```bash
cd /opt/live-stream
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

---

## Anti-patterns to avoid

- **Don't** call Prisma from `application/` or `interfaces/` layers — go through a port.
- **Don't** add a "service" class in `application/` that takes a Prisma client in its constructor — that's not clean architecture, that's just spaghetti with extra steps.
- **Don't** introduce a new task type without first adding it to the `TaskType` enum + handler registry.
- **Don't** swallow `Task` errors silently — every failure must populate `errorMessage`.
- **Don't** call back from Python to Node "for status updates" — Python writes to DB, the UI polls.
- **Don't** add backwards-compat shims for code that's being deleted. Just delete it.
- **Don't** create new files with leading "_" or "deprecated_" prefix to "soft-delete" — delete or keep, no in-between.
- **Don't** generate documentation files (.md) that aren't asked for. `task.md` and `skill.md` are the only docs maintained alongside code.

---

## Migration discipline for the big refactor

1. **Phase 1 first, fully.** Don't start Phase 2 until Phase 1 ships and Postgres-based queueing works end-to-end.
2. **One PR per slice** when possible: schema → ports → use-cases → infrastructure → wire-up → delete legacy. Easier to review, easier to revert.
3. **Typecheck after every slice.** Both `backend` and `frontend`.
4. **Smoke test the recording flow** after each slice: record 30 s, watch it process, confirm playback works.
5. When you delete legacy (BullMQ etc.), also delete its config, env vars, and docs. Half-deleted code is worse than not-deleted.

---

## When in doubt

- Default to deletion over preservation.
- Default to the simpler option (polling Postgres) over the cleverer one (LISTEN/NOTIFY) until measured otherwise.
- Default to no comments unless explaining *why*.
- Default to one cohesive file unless the file passes 500 lines or two clearly different responsibilities.
- Default to "what does the user need" over "what would be technically interesting."
