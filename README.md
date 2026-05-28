# Online Learning Platform — Demo MVP

Session-based teaching platform with browser screen+audio recording and later playback.

Full architecture & roadmap: **[TECHNICAL-PLAN.md](./TECHNICAL-PLAN.md)**

---

## Project structure

```
online-education/
├── TECHNICAL-PLAN.md       # 12-section planning document
├── docker-compose.yml      # postgres + redis + minio (S3-compatible)
├── backend/                # Node.js + Express + Prisma + BullMQ + FFmpeg
├── frontend/               # Next.js 14 (App Router) + Tailwind
└── whisper-server/         # Python FastAPI + faster-whisper (transcription + LLM)
```

---

## Prerequisites

| Tool            | Purpose                                    |
|-----------------|--------------------------------------------|
| Node.js ≥ 20    | Run backend + frontend                     |
| pnpm            | Package manager                            |
| Docker Desktop  | Run Postgres + Redis + MinIO               |
| Python ≥ 3.12   | Run whisper-server (optional)              |

Install pnpm if you don't have it:
```bash
npm install -g pnpm
```

---

## First-time setup

### 1. Start infra — Postgres, Redis, MinIO

Make sure Docker Desktop is running, then:

```bash
cd /path/to/online-education
docker compose up -d
docker compose ps
```

You should see 3 services (postgres, redis, minio) in the `running` state, along with `minio-init` which creates the `olp-recordings` bucket and exits.

**Consoles for checking:**
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)
- Postgres: `localhost:5432` (user `olp`, password `olp`, db `olp`)
- Redis: `localhost:6379`

### 2. Set up backend

```bash
cd backend
cp .env.example .env
pnpm install
pnpm prisma generate
pnpm prisma migrate dev --name init   # create schema in Postgres
pnpm seed                              # insert demo users + courses + sessions
```

### 3. Set up frontend

```bash
cd ../frontend
cp .env.example .env.local
pnpm install
```

---

## ⚠️ If you've already set up before — run additional migrations

The schema has changed several times (thumbnail+chapters, progress, questions, chat, **joinCode, visibility, chat attachments, transcript**). Run once:

```bash
cd backend
pnpm install
pnpm prisma migrate dev --name add-join-code-visibility-attachments-transcript
pnpm seed   # adds joinCode to seeded courses

cd ../frontend
pnpm install
```

---

## Whisper transcription (audio → text)

**Phase 2:** Whisper runs as a separate Python FastAPI server (no cloud) — `whisper-server/` in this project. Python calls the LLM itself and writes transcript/summary directly to Postgres. The Node API just hands off the mp3 + task_id and receives HTTP 202 in return.

Pipeline:
```
recording.mp4 → extract mp3 → POST /v1/tasks (whisper-server) → 202
                                                ↓
                                        Python BackgroundTask
                                          ├─ faster-whisper transcribe
                                          ├─ LLM summary + chapters
                                          └─ write Postgres (transcript + summary)
```

Set up whisper-server (one-time, see `whisper-server/README.md` for details):

```bash
cd whisper-server
python3.12 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env: set LLM_API_URL / LLM_API_KEY / LLM_MODEL (for summaries)
python server.py
# server listening on :8000
```

Backend `.env`:

```bash
WHISPER_API_KEY=local                           # server does not check
WHISPER_API_BASE_URL=http://localhost:8000/v1   # or host.docker.internal:8000/v1 in docker
```

Model size trades off RAM vs. quality (set in `whisper-server/.env`):

| Model | RAM | Speed (CPU) | Quality |
|---|---|---|---|
| `tiny` | ~0.5 GB | Fastest | Usable |
| `small` | ~1 GB | Balanced | Good |
| `medium` | ~2.5 GB | Slow | Very good |
| `large-v3` | ~5 GB | Very slow on CPU | Best |

Have a GPU? Set `WHISPER_DEVICE=cuda` in `whisper-server/.env`.

### Disable transcription

Leave `WHISPER_API_BASE_URL` empty or don't run whisper-server — recording still works, you just won't get transcript/summary/search.

---

## LLM post-processing (summary + auto-chapters)

**Phase 2:** LLM calls have moved into `whisper-server/` (Python) — the Node API no longer calls the LLM itself. All `LLM_*` env settings live in `whisper-server/.env`. See `whisper-server/README.md` for supported providers (Ollama local/cloud, Typhoon, OpenAI-compatible).

Once the transcript is ready, Python calls the LLM to:
1. **Summarize the lecture** in 2–3 sentences → displayed above the video
2. **Auto-generate chapters** if the teacher didn't mark them → tagged with an "AI-generated" badge

Disable LLM: leave `LLM_API_URL` empty in `whisper-server/.env` — transcripts still work, you just won't get summaries/chapters.

---

## Day-to-day run (3 terminals required)

Open Docker Desktop → `docker compose up -d` → then open 3 terminals:

**Terminal 1 — API**
```bash
cd backend
pnpm dev
# [api] listening on http://localhost:4000
```

**Terminal 2 — Worker (FFmpeg processing)**
```bash
cd backend
pnpm worker
# [worker] ready
```

**Terminal 3 — Frontend**
```bash
cd frontend
pnpm dev
# http://localhost:3000
```

Open http://localhost:3000 and click a persona to log in with one click.

---

## Demo personas (seed password: `demo1234` for all)

| Email              | Role in ENG-101 | Note                         |
|--------------------|-----------------|------------------------------|
| priya@acme.edu     | TEACHER (owner) | Teaches ENG-101 + PM-305     |
| marcus@acme.edu    | —               | Teaches DS-220               |
| jae@corp.com       | STUDENT         | Enrolled in ENG-101 + DS-220 |
| lena@corp.com      | STUDENT         | Enrolled in ENG-101 + PM-305 |
| omar@corp.com      | STUDENT         | Enrolled in ENG-101          |
| tess@corp.com      | STUDENT         | Enrolled in ENG-101          |

---

## Suggested demo flow

1. Log in as **Priya** → `/dashboard` → click into the ENG-101 course
2. Click **Start recording** on any session → pick a screen + allow mic
3. Speak for ~30 seconds → click **Stop recording** → status becomes `processing…`
4. Wait for the worker to transcode (typically 5–30 s for a short clip) → status becomes `ready`
5. Open another incognito window → log in as **Jae-won** → open the same session → press play

---

## Verify the API is up

```bash
curl http://localhost:4000/health
# {"ok":true}

curl -X POST http://localhost:4000/api/v1/auth/demo/switch \
  -H 'Content-Type: application/json' \
  -d '{"email":"priya@acme.edu"}'
# {"token":"...","user":{...}}
```

---

## Commands cheat sheet

Run from the repo root (workspace scripts are defined in the root `package.json`):

| Command                     | What it does                                   |
|-----------------------------|------------------------------------------------|
| `pnpm infra:up`             | Start Postgres / Redis / MinIO                 |
| `pnpm infra:down`           | Stop infra                                     |
| `pnpm infra:reset`          | Stop + drop volumes + start fresh (full reset) |
| `pnpm backend:dev`          | Start API server                               |
| `pnpm backend:worker`       | Start FFmpeg worker                            |
| `pnpm backend:seed`         | Re-seed demo data                              |
| `pnpm backend:migrate`      | Run Prisma migrations                          |
| `pnpm backend:studio`       | Open Prisma Studio (DB viewer)                 |
| `pnpm frontend:dev`         | Start Next.js                                  |
| `pnpm setup`                | Install + migrate + seed (one-shot)            |

---

## Troubleshooting

| Problem                                              | Fix                                                                       |
|------------------------------------------------------|---------------------------------------------------------------------------|
| `docker: command not found`                          | Open Docker Desktop; `brew install --cask docker` if not installed       |
| Prisma: `Can't reach database server at localhost:5432` | `docker compose ps` to check postgres; `lsof -i :5432` for port clashes |
| Worker log `ffmpeg: not found`                       | `pnpm install` again in `backend/` — `ffmpeg-static` will download the binary |
| MinIO bucket missing                                 | http://localhost:9001 → log in → create the `olp-recordings` bucket manually |
| Recording UI doesn't prompt for permission           | Use Chrome / Edge; Safari is not supported in MVP (see Known limits)     |
| `CORS` error in the browser                          | Check `CORS_ORIGIN=http://localhost:3000` in `backend/.env`              |
| Bounced back to `/login` after logging in            | Cookie blocked — use a regular browser (not strict incognito) or Chrome  |

---

## Deploy architecture (single-origin, no cross-domain cookies)

```
                  ┌──────────────────────────────┐
Browser ───────►  │ Next.js (port 3000)          │
 cookies          │  /                → Next SSR │
 same-origin      │  /api/*           → BACKEND  │ (rewrite)
                  │  /socket.io/*     → BACKEND  │ (rewrite + WS upgrade)
                  └──────────────┬───────────────┘
                                 │ BACKEND_URL
                                 │ (internal only)
                                 ▼
                  ┌──────────────────────────────┐
                  │ Express API + Socket.IO      │
                  │ (port 4000)                  │
                  └──────────────────────────────┘
```

The browser only talks to the Next.js origin:
- **Cookies** = first-party → `SameSite=lax` is enough; no `SameSite=none; Secure` + CORS dance needed
- **CORS** is a non-issue because it's same-origin
- **WebSocket** — self-hosted Next 14 proxies WS upgrades out of the box, no extra config

Required env vars:

| Var | Scope | Value |
|---|---|---|
| `BACKEND_URL` | Next server | Internal URL of the API, e.g. `http://api:4000` in docker, or `http://localhost:4000` in dev |
| `NEXT_PUBLIC_API_BASE` | **build-time** | `/api/v1` (relative) — baked into the bundle |
| `COOKIE_SECURE` | backend | `true` when served over HTTPS |
| `COOKIE_SAMESITE` | backend | `lax` (default) |
| `JWT_SECRET` | backend | Long random string |

### Deploy with Docker Compose

```bash
# 1. Build + start every service (api, worker, web + infra)
JWT_SECRET='your-long-prod-secret' \
COOKIE_SECURE=true \
docker compose --profile app up -d --build

# 2. First-time migration
docker compose exec api npx prisma migrate deploy
docker compose exec api npx tsx prisma/seed.ts   # optional

# 3. Open http://localhost:3000 — you never need to hit :4000 from the browser
```

Prod tip: remove the `ports: ["4000:4000"]` line from the `api` service in `docker-compose.yml` so the API isn't exposed directly to the internet (the browser only goes through the Next.js proxy).

### Deploy behind a reverse proxy (nginx / caddy)

If you want an additional reverse proxy in front (TLS termination, rate limiting, etc.):

```nginx
# nginx.conf — one domain, both services
server {
  server_name app.example.com;
  listen 443 ssl http2;
  # ssl_* directives...

  location / {
    proxy_pass http://web:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # WS through Next
    proxy_set_header Connection "upgrade";
  }
}
```

Next.js handles rewriting `/api` + `/socket.io` to the backend behind it — nginx never has to touch the API directly.

---

## Tests

Smoke tests (vitest + supertest) covering auth + course CRUD + permission:

```bash
docker compose up -d   # infra must be up first
pnpm backend:seed       # seed data
cd backend && pnpm test
```

---

## Live classroom (new)

The platform now supports live classrooms:
- Teacher hits Start recording → recording happens **and** the stream is published to students simultaneously (WebRTC mesh + Socket.io signaling)
- Students opening a session while it's LIVE → see the video + chat + ask questions in real time
- Student presses **✋ Raise hand** → teacher Accepts → browser prompts for cam+mic → student publishes back to the teacher
- Questions can also be left to ask later (archived questions on the session page)

**MVP scale limit:** WebRTC mesh is fine for 1 teacher + ≤ 8 students. Beyond that you need an SFU (e.g. LiveKit/mediasoup) instead.

---

## Known MVP limits (intentionally deferred)

- **Chrome/Edge only** for recording (WebM / VP8+Opus) — Safari is Phase 2
- **Chapters on the playback page are placeholders** — auto-chapter detection is Phase 2
- **No email notifications** — the worker just logs "would notify"
- **Live class mesh** — demo-scale only; SFU required for > 8 students

See [TECHNICAL-PLAN.md §1 & §12](./TECHNICAL-PLAN.md) for the full exclusion list + risk table.
