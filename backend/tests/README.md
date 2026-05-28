# Tests

Smoke tests hit a real Postgres + Redis + MinIO stack (use the dev docker-compose).

```bash
docker compose up -d
pnpm prisma migrate deploy
pnpm seed
pnpm test
```

Tests are intentionally minimal — they verify the happy paths end-to-end, not
every edge case. The goal is CI confidence that auth + course + session CRUD
still work after refactors.
