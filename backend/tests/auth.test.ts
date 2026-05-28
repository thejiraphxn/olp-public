import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import 'dotenv/config';

// Boot a test app that reuses the real server configuration.
// Tests require the dev docker-compose stack to be running.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from '../src/modules/auth/auth.routes.js';
import { coursesRouter } from '../src/modules/courses/courses.routes.js';
import { sessionsRouter } from '../src/modules/sessions/sessions.routes.js';
import { errorHandler } from '../src/middleware/error.js';

const app = express();
app.use(cors({ credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/courses', coursesRouter);
app.use('/api/v1/courses/:courseId/sessions', sessionsRouter);
app.use(errorHandler);

describe('auth + courses smoke', () => {
  let token: string;

  beforeAll(async () => {
    // demo/switch works without password because seeded user exists
    const res = await request(app)
      .post('/api/v1/auth/demo/switch')
      .send({ email: 'priya@acme.edu' });
    expect(res.status).toBe(200);
    token = res.body.token;
  });

  it('GET /me returns the logged-in user', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('priya@acme.edu');
    expect(Array.isArray(res.body.memberships)).toBe(true);
  });

  it('GET /courses returns paginated list', async () => {
    const res = await request(app)
      .get('/api/v1/courses?limit=10')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('GET /courses supports search', async () => {
    const res = await request(app)
      .get('/api/v1/courses?q=ENG')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // the seed has ENG-101 under Priya
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('rejects requests without auth', async () => {
    const res = await request(app).get('/api/v1/courses');
    expect(res.status).toBe(401);
  });

  it('rejects foreign course access', async () => {
    // marcus owns DS-220 — priya is not a member
    const sw = await request(app)
      .post('/api/v1/auth/demo/switch')
      .send({ email: 'marcus@acme.edu' });
    const marcusToken = sw.body.token;

    const marcusCourses = await request(app)
      .get('/api/v1/courses')
      .set('Authorization', `Bearer ${marcusToken}`);
    const ds220 = marcusCourses.body.items.find((c: any) => c.code === 'DS-220');
    expect(ds220).toBeTruthy();

    const res = await request(app)
      .get(`/api/v1/courses/${ds220.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
