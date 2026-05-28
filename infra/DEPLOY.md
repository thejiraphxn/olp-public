# Deploy Runbook

Two scenarios:

1. **First-time deploy** — fresh VPS, no data, full setup
2. **Continuous deploy** — update code without losing existing data

Production target: `https://trsonline.mithat.co.th:8443` on Ubuntu 24.04. Port 80/443 are owned by another service on this host, so this stack listens on **8443** with the existing wildcard cert (`*.mithat.co.th`).

## Architecture (Phase 2)

```
Internet :8443 ──HTTPS──▶ host Nginx ──┬──▶ 127.0.0.1:3000  (web — Next.js standalone)
                                       │       └─▶ docker net ──▶ api:4000
                                       │
                                       ├──▶ 127.0.0.1:9000  (MinIO — /olp-recordings/* SigV4)
                                       │
                                       └──▶ 127.0.0.1:3000  (Socket.IO upgrade)

api container ──▶ host.docker.internal:8000 ──▶ whisper-server (Python, systemd)
                                                      └─▶ Ollama Cloud (LLM, outbound HTTPS)
                                                      └─▶ Postgres (writes transcript/summary)
```

- All container ports bind `127.0.0.1` only. Host Nginx is the sole public entrypoint
- whisper-server runs **outside** docker — Python venv + systemd, owns transcribe + LLM end-to-end
- MinIO uses **bind mount** at `/opt/live-stream/data/minio` so operators can browse / back up files directly
- Postgres uses a **named volume** (`olp_pg`) — no need to inspect on disk

## Paths + conventions used below

```
/opt/live-stream-platform/      ← repo (rsynced from Mac, NOT a git checkout)
/opt/live-stream/data/minio/    ← MinIO bind mount
/opt/live-stream-platform/whisper-server/venv/   ← Python venv
SSH user: mithat
Domain:   trsonline.mithat.co.th
Port:     8443 (HTTPS)
```

---

# 1. First-time deploy

Use this when the VPS is fresh / has nothing yet. Runs once.

## 1.1 VPS prep

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version    # confirm

# Python (for whisper-server)
sudo apt update && sudo apt install -y python3.12 python3.12-venv ffmpeg

# Firewall — open only what we publish
sudo ufw allow OpenSSH
sudo ufw allow 8443/tcp
sudo ufw enable
sudo ufw status
```

## 1.2 Create project paths

```bash
sudo mkdir -p /opt/live-stream-platform /opt/live-stream/data/minio
sudo chown -R $(id -u):$(id -g) /opt/live-stream-platform /opt/live-stream/data
```

## 1.3 Push code from Mac → VPS

From the Mac (project root):

```bash
rsync -avz --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'dist' --exclude '.env' --exclude '.env.local' \
  --exclude '.env.production' --exclude 'backups' --exclude 'data' \
  --exclude 'whisper-server/venv' --exclude '.DS_Store' \
  --exclude 'tsconfig.tsbuildinfo' \
  ./ mithat@trsonline:/opt/live-stream-platform/
```

## 1.4 Configure secrets

On VPS:

```bash
cd /opt/live-stream-platform
cp .env.production.example .env.production
chmod 600 .env.production

# Generate strong values + paste them into .env.production:
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '=+/')"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -base64 32 | tr -d '=+/')"
echo "JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')"

# Set OLP_DATA_UID/GID to match the host user (so MinIO bind mount perms work):
sed -i "s/^OLP_DATA_UID=.*/OLP_DATA_UID=$(id -u)/" .env.production
sed -i "s/^OLP_DATA_GID=.*/OLP_DATA_GID=$(id -g)/" .env.production

nano .env.production    # final review
```

Required to fill in: `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `JWT_SECRET`. Other defaults work as-is.

## 1.5 Whisper-server setup (Python, outside docker)

```bash
cd /opt/live-stream-platform/whisper-server
python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# whisper-server has its own .env — the LLM provider lives here, NOT in
# the Node .env.production.
cp .env.example .env
nano .env
# minimum to fill in:
#   LLM_API_URL=...      (e.g. https://ollama.com/v1)
#   LLM_API_KEY=...
#   LLM_MODEL=...        (e.g. gemma3:27b-cloud)
chmod 600 .env

# Sanity check the model loads (Ctrl+C after "Uvicorn running on ...:8000")
python server.py
```

The first run downloads `large-v3` model (~1.5 GB) to `~/.cache/faster-whisper`. Subsequent restarts are instant.

### Daemonize as systemd

```bash
sudo tee /etc/systemd/system/whisper-server.service > /dev/null <<EOF
[Unit]
Description=Local Whisper Server
After=network.target postgresql.service docker.service

[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=/opt/live-stream-platform/whisper-server
EnvironmentFile=/opt/live-stream-platform/whisper-server/.env
ExecStart=/opt/live-stream-platform/whisper-server/venv/bin/python server.py
Restart=on-failure
RestartSec=5
# If the kernel runs out of memory, sacrifice whisper-server before docker
# (which has CRITICAL live-class connections). Higher score = killed earlier.
OOMScoreAdjust=500
# Cap restart loops so a permanent config bug (bad DATABASE_URL, missing
# model cache, etc.) doesn't burn CPU forever — operator gets a clean
# "failed" status to investigate instead.
StartLimitIntervalSec=300
StartLimitBurst=5
# Resource caps — adjust to your VPS. Memory cap kills the process before
# it OOMs the host; nofile prevents FD exhaustion under bursty load.
MemoryHigh=8G
MemoryMax=10G
LimitNOFILE=65536
# Hardening — least-privilege filesystem access. Comment out if your
# venv/cache lives outside /opt or /home.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now whisper-server
sudo systemctl status whisper-server --no-pager
journalctl -u whisper-server -n 30 --no-pager      # confirm "Uvicorn running on http://0.0.0.0:8000"
```

## 1.6 Install Nginx server block

The repo ships `infra/nginx/trsonline-app.conf` listening on **8443**. It coexists with whatever already owns `:443`.

```bash
sudo cp /opt/live-stream-platform/infra/nginx/trsonline-app.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/trsonline-app.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

The cert path inside the file points at `/var/www/ssl_start_mithat.co.th/nginx/star_mithat_co_th_combine.pem` (existing wildcard). If your cert lives elsewhere, edit the file before symlinking.

## 1.7 Build + start the docker stack

```bash
cd /opt/live-stream-platform
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api
```

API on first boot:
- runs `prisma migrate deploy` (applies all migrations)
- runs `pnpm seed` (idempotent — demo accounts)
- starts the HTTP server + embedded TaskWorker (Postgres-backed, no Redis)

Wait for: `api + socket.io listening`.

## 1.8 Smoke test

```bash
curl -sI https://trsonline.mithat.co.th:8443/                     # 307 / 200 with x-nextjs-cache
curl -s  https://trsonline.mithat.co.th:8443/api/v1/auth/me       # JSON 401 (means API reachable)
```

Open in browser → log in as `priya@acme.edu` / `demo1234` → record a 30s test session → wait for transcript + summary.

## 1.9 Disable seed on subsequent boots

After the first successful deploy, prevent the ~3s seed step on every restart:

```bash
sed -i 's/^SEED_ON_BOOT=true/SEED_ON_BOOT=false/' .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

---

# 2. Continuous deploy (preserve data)

Use this for **every update after the first deploy**. Postgres + MinIO data survive untouched.

The pattern is always: rsync from Mac → rebuild only what changed on VPS.

## 2.1 Push changes from Mac

```bash
# From the Mac, project root
rsync -avz --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'dist' --exclude '.env' --exclude '.env.local' \
  --exclude '.env.production' --exclude 'backups' --exclude 'data' \
  --exclude 'whisper-server/venv' --exclude '.DS_Store' \
  --exclude 'tsconfig.tsbuildinfo' \
  ./ mithat@trsonline:/opt/live-stream-platform/
```

`--delete` removes files on VPS that no longer exist on Mac (e.g. legacy files cleaned up locally) — required to avoid stale `.ts` files breaking the build.

`.env.production` is **excluded** — never overwritten by rsync. Edit it manually on the VPS if vars change.

## 2.2 Decide what to redeploy

Match the change to the right command:

| What changed                                            | Command on VPS                                               |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `backend/src/**`                                        | `docker compose ... up -d --build api`                       |
| `frontend/**` (page/component/style)                    | `docker compose ... up -d --build web`                       |
| `backend/prisma/migrations/**` (new migration)          | `docker compose ... up -d --build api` — runs migrate on boot |
| `whisper-server/**.py`                                  | `sudo systemctl restart whisper-server`                      |
| `whisper-server/.env`                                   | `sudo systemctl restart whisper-server`                      |
| `.env.production` (Node-side env)                       | `docker compose ... up -d`  (re-creates affected containers) |
| `docker-compose.prod.yml`                               | `docker compose ... up -d` (re-creates services)             |
| `infra/nginx/trsonline-app.conf`                        | `sudo cp ... && sudo nginx -t && sudo systemctl reload nginx` |
| Both backend + frontend                                 | `docker compose ... up -d --build api web`                   |

Substitute `...` with the standard prefix:

```bash
ENV_FLAG="--env-file .env.production -f docker-compose.prod.yml"
cd /opt/live-stream-platform
```

## 2.3 Common redeploy recipes

### Recipe A — backend code change only

```bash
cd /opt/live-stream-platform
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build api
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api
```

Postgres / MinIO / web stay running. Wait for `api + socket.io listening`.

### Recipe B — frontend code change only

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build web
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f web
```

⚠️ If you changed `BACKEND_URL`, `NEXT_PUBLIC_*`, or `next.config.mjs` rewrites, you **must** rebuild — Next.js bakes these into `required-server-files.json` at build time:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml build --no-cache web
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate web
```

### Recipe C — both backend + frontend

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build api web
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api web
```

### Recipe D — Python whisper-server change

```bash
sudo systemctl restart whisper-server
journalctl -u whisper-server -f
```

### Recipe E — Nginx config change

```bash
sudo cp /opt/live-stream-platform/infra/nginx/trsonline-app.conf /etc/nginx/sites-available/
sudo nginx -t
sudo systemctl reload nginx
```

`reload` (not restart) — drops zero connections.

### Recipe F — Prisma migration

Migrations run automatically on api container boot via `pnpm prisma migrate deploy`. After rsync that includes `backend/prisma/migrations/<new>/`:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build api
docker compose --env-file .env.production -f docker-compose.prod.yml logs api | grep -i migrat
```

Look for `All migrations have been successfully applied.` If migrate fails:

```bash
# Force-run migrate against the live DB
docker compose --env-file .env.production -f docker-compose.prod.yml exec api pnpm prisma migrate deploy
```

### Recipe G — env var change

After editing `.env.production`:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Compose will re-create containers whose env actually changed. `restart` won't pick up env changes.

## 2.4 Operational

### Logs

```bash
ENV_FLAG="--env-file .env.production -f docker-compose.prod.yml"
docker compose $ENV_FLAG logs -f api                       # real-time api log
docker compose $ENV_FLAG logs --tail=200 web               # last 200 lines
docker compose $ENV_FLAG logs --since 10m api              # last 10 minutes
journalctl -u whisper-server -f                            # whisper / LLM
```

### Postgres backup (daily cron)

```bash
mkdir -p /opt/live-stream-platform/backups
docker compose -f /opt/live-stream-platform/docker-compose.prod.yml exec -T postgres \
  pg_dump -U olp olp | gzip > /opt/live-stream-platform/backups/olp-$(date +%F).sql.gz

# crontab -e
0 3 * * * cd /opt/live-stream-platform && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U olp olp | gzip > backups/olp-$(date +\%F).sql.gz
```

### MinIO backup

```bash
# Bind mount makes this a plain tar — but stop minio briefly to avoid catching mid-write objects
docker compose -f /opt/live-stream-platform/docker-compose.prod.yml stop minio
sudo tar -czf /opt/live-stream-platform/backups/minio-$(date +%F).tar.gz \
  -C /opt/live-stream/data minio/olp-recordings
docker compose --env-file /opt/live-stream-platform/.env.production -f /opt/live-stream-platform/docker-compose.prod.yml start minio
```

For zero-downtime backup, use `mc mirror local/olp-recordings s3://offsite-backup/...` instead.

### MinIO console

Bound to `127.0.0.1:9001`. Tunnel from laptop:

```bash
ssh -L 9001:127.0.0.1:9001 mithat@trsonline
# open http://localhost:9001 → login with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
```

### Task admin

In the app: Sidebar → **⚙ Worker** (teacher login). REST API at `/api/v1/admin/tasks` for scripting.

### Restart one service

```bash
ENV_FLAG="--env-file .env.production -f docker-compose.prod.yml"
docker compose $ENV_FLAG restart api      # use restart for crash recovery
docker compose $ENV_FLAG up -d api        # use up -d after env / image change
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `502 Bad Gateway` on `/` | web container not up | `docker compose ... ps`, then `logs web` |
| `nginx: [emerg] unknown directive "http2"` | Nginx 1.24 doesn't support `http2 on;` directive | Use `listen 8443 ssl http2;` (already in the conf file) |
| Build fails: `Cannot find module 'bullmq'` | Legacy files still on VPS | rsync MUST use `--delete`; manual `rm -rf backend/src/jobs backend/src/lib/redis.ts backend/src/modules/admin/queue.routes.ts` |
| Build fails: `node:sqlite not found` (frontend) | Corepack pulling pnpm 11 (needs Node 22) | Pin `packageManager: "pnpm@10.33.1+sha512..."` in `frontend/package.json` |
| `Failed to proxy http://localhost:4000` (web log) | `BACKEND_URL` not set as build arg | Confirm `BACKEND_URL: http://api:4000` is under `web.build.args` in compose |
| MinIO `file access denied` on start | UID/GID of `OLP_DATA_DIR` ≠ container user | `sudo chown -R $(id -u):$(id -g) /opt/live-stream/data && update OLP_DATA_UID/GID in .env.production` |
| MinIO upload 403 | `PUBLIC_S3_ENDPOINT` mismatch | Must be exactly `https://trsonline.mithat.co.th:8443` (no trailing slash, no path) |
| Whisper "max() iterable argument is empty" | Audio with zero speech (faster-whisper bug) | Already guarded in `whisper-server/server.py` — if seen, restart whisper-server |
| `prisma migrate deploy` fails | DB not ready yet | Wait for `postgres` healthcheck, then `restart api` |
| Login OK but next request 401 | Cookie not sticking | Confirm `COOKIE_SECURE=true` in `.env.production` and browser sees `Secure; HttpOnly` |
| Late chat joiners see empty chat | Server-side push not deployed | Pushed via `chat:history` socket event after `room:join` ack — restart api |

---

## Sanity checklist after every deploy

- [ ] `https://trsonline.mithat.co.th:8443/` serves login page
- [ ] Existing user can log in (no auth regression)
- [ ] `docker compose ... ps` — all containers `Up`/`healthy`
- [ ] `journalctl -u whisper-server -n 5` — no crash since restart
- [ ] Open an ENDED session — playback page tabs switch cleanly (Transcript / Chat / Questions / Attendance)
- [ ] Record a 30s clip → transcript appears → summary follows

---

## Notes

- **Never** push secrets to git: `.env.production`, `whisper-server/.env`, `backend/.env` are all gitignored
- `.env.production` should be `chmod 600`
- whisper-server runs **outside** docker on purpose — model load is faster, swappable via env, and it owns LLM calls in Phase 2
- Cookie name is `olp_token` — won't collide with PHPSESSID if another app shares the host
- Container port `4000` (api) is intentionally not exposed publicly — Next.js reaches it via the docker network. Debug: `docker compose ... exec api sh`
- For zero-downtime upgrades, the api container's TaskWorker uses leases — restarting mid-job lets the next worker pick up where it left off (after lease expires, ~60s)
