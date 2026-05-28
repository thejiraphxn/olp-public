import './lib/bigint.js'; // must be first — patches BigInt.prototype.toJSON
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { coursesRouter } from './modules/courses/courses.routes.js';
import { membersRouter } from './modules/memberships/memberships.routes.js';
import { sessionsRouter } from './modules/sessions/sessions.routes.js';
import { recordingsRouter } from './modules/recordings/recordings.routes.js';
import { playbackRouter } from './modules/playback/playback.routes.js';
import { progressRouter } from './modules/playback/progress.routes.js';
import { questionsRouter } from './modules/live/questions.routes.js';
import { uploadsRouter } from './modules/live/uploads.routes.js';
import { tasksRouter } from './modules/admin/tasks.routes.js';
import { attachLiveServer } from './live/server.js';
import { errorHandler } from './middleware/error.js';
import { buildContainer } from './composition.js';

const app = express();

// Build the composition container ONCE at startup. Use-case wiring,
// adapters, and the TaskWorker all live here.
const container = buildContainer();
app.locals.container = container;

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

const corsOriginRaw = config.corsOrigin.trim();
const corsAllowAll = corsOriginRaw === '*';
const allowList = corsAllowAll
  ? null
  : new Set(
      corsOriginRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsAllowAll) return cb(null, origin);
      if (allowList && allowList.has(origin)) return cb(null, origin);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/ping', (_req, res) => res.type('text/plain').send('pong'));

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/courses', coursesRouter);
app.use('/api/v1/courses/:courseId/members', membersRouter);
app.use('/api/v1/courses/:courseId/sessions', sessionsRouter);
app.use(
  '/api/v1/courses/:courseId/sessions/:sessionId/recordings',
  recordingsRouter,
);
app.use(
  '/api/v1/courses/:courseId/sessions/:sessionId/playback',
  playbackRouter,
);
app.use('/api/v1/progress', progressRouter);
app.use(
  '/api/v1/courses/:courseId/sessions/:sessionId/questions',
  questionsRouter,
);
app.use(
  '/api/v1/courses/:courseId/sessions/:sessionId/uploads',
  uploadsRouter,
);
// Postgres-backed task admin (replaces bull-board / BullMQ).
app.use('/api/v1/admin/tasks', tasksRouter);

app.use(errorHandler);

const httpServer = http.createServer(app);
attachLiveServer(httpServer);

httpServer.listen(config.port, () => {
  logger.info({ port: config.port }, 'api + socket.io listening');
});

// Embedded TaskWorker — Postgres-backed pipeline driver. Opt-out by
// setting EMBED_WORKER=false if running a dedicated worker process.
if (process.env.EMBED_WORKER !== 'false') {
  container.worker.start();
}

// Graceful shutdown — drain the in-flight task before closing HTTP.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, 'shutting down');
    try {
      await container.worker.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } catch (e) {
      logger.warn({ err: String(e) }, 'shutdown hiccup');
    }
    process.exit(0);
  });
}
