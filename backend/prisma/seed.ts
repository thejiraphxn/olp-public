import { PrismaClient, CourseRole, SessionStatus, RecordingStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('demo1234', 10);

  const seedUsers = [
    { email: 'priya@acme.edu',  name: 'Priya Anand',    demoBlurb: 'Teaching ENG-101 + PM-305' },
    { email: 'marcus@acme.edu', name: 'Marcus Ojeda',   demoBlurb: 'Teaching DS-220' },
    { email: 'jae@corp.com',    name: 'Jae-won Park',   demoBlurb: 'Enrolled in 2 courses' },
    { email: 'lena@corp.com',   name: 'Lena Kowalski',  demoBlurb: 'Enrolled in 2 courses' },
    { email: 'omar@corp.com',   name: 'Omar Haidari',   demoBlurb: 'Enrolled in ENG-101' },
    { email: 'tess@corp.com',   name: 'Tess Vanderberg',demoBlurb: 'Enrolled in ENG-101' },
  ];
  const users = await Promise.all(
    seedUsers.map((u) =>
      db.user.upsert({
        where: { email: u.email },
        update: { isDemo: true, demoBlurb: u.demoBlurb },
        create: { ...u, passwordHash: hash, isDemo: true },
      }),
    ),
  );
  const [priya, marcus, jae, lena, omar, tess] = users;

  const eng101 = await db.course.upsert({
    where: { code: 'ENG-101' },
    update: { joinCode: 'ENG101-JOIN', coverColor: '#ffd5b8' },
    create: {
      code: 'ENG-101',
      title: 'Technical Writing for Engineers',
      description: 'Clear, concise writing for specs, RFCs and PRs.',
      joinCode: 'ENG101-JOIN',
      coverColor: '#ffd5b8',
      visibility: 'PRIVATE',
      ownerId: priya.id,
    },
  });

  const ds220 = await db.course.upsert({
    where: { code: 'DS-220' },
    update: { joinCode: 'DS220-JOIN', coverColor: '#d8e4ff' },
    create: {
      code: 'DS-220',
      title: 'Intro to Data Structures',
      description: 'Arrays, trees, graphs — with live-coding walkthroughs.',
      joinCode: 'DS220-JOIN',
      coverColor: '#d8e4ff',
      visibility: 'PUBLIC',
      ownerId: marcus.id,
    },
  });

  const pm305 = await db.course.upsert({
    where: { code: 'PM-305' },
    update: { joinCode: 'PM305-JOIN', coverColor: '#e4d8ff' },
    create: {
      code: 'PM-305',
      title: 'Product Management Fundamentals',
      description: 'Roadmaps, user research, prioritization frameworks.',
      joinCode: 'PM305-JOIN',
      coverColor: '#e4d8ff',
      visibility: 'PRIVATE',
      ownerId: priya.id,
    },
  });

  // memberships
  const memberships: Array<[string, string, CourseRole]> = [
    [eng101.id, priya.id, 'TEACHER'],
    [eng101.id, jae.id, 'STUDENT'],
    [eng101.id, lena.id, 'STUDENT'],
    [eng101.id, omar.id, 'STUDENT'],
    [eng101.id, tess.id, 'STUDENT'],
    [ds220.id, marcus.id, 'TEACHER'],
    [ds220.id, jae.id, 'STUDENT'],
    [pm305.id, priya.id, 'TEACHER'],
    [pm305.id, lena.id, 'STUDENT'],
  ];
  for (const [courseId, userId, role] of memberships) {
    await db.courseMember.upsert({
      where: { courseId_userId: { courseId, userId } },
      update: { role },
      create: { courseId, userId, role },
    });
  }

  // sessions for ENG-101
  const sessionSpecs: Array<{
    title: string;
    n: number;
    status: SessionStatus;
    rec?: RecordingStatus;
  }> = [
    { title: 'Why technical writing matters', n: 1, status: 'ENDED', rec: 'READY' },
    { title: 'Structuring a technical document', n: 2, status: 'ENDED', rec: 'READY' },
    { title: 'Writing clear API references', n: 3, status: 'ENDED', rec: 'READY' },
    // Previously seeded as PROCESSING to showcase the UI state — removed
    // because it gets stuck forever (no raw file to actually process).
    { title: 'Peer-review workshop', n: 4, status: 'ENDED', rec: 'READY' },
    { title: 'Docs for distributed systems', n: 5, status: 'SCHEDULED' },
    { title: 'RFC patterns', n: 6, status: 'SCHEDULED' },
    { title: 'Edge cases & error messages', n: 7, status: 'DRAFT' },
    { title: 'Final review', n: 8, status: 'DRAFT' },
  ];

  for (const s of sessionSpecs) {
    const titleKey = `${eng101.code}-S${s.n}`;
    const existing = await db.courseSession.findFirst({
      where: { courseId: eng101.id, title: s.title },
    });
    const session =
      existing ??
      (await db.courseSession.create({
        data: {
          courseId: eng101.id,
          title: s.title,
          scheduledAt: new Date(Date.now() + s.n * 86400000),
          status: s.status,
          startedAt: s.status === 'ENDED' ? new Date(Date.now() - s.n * 3600000) : null,
          endedAt: s.status === 'ENDED' ? new Date(Date.now() - s.n * 3500000) : null,
        },
      }));
    if (s.rec) {
      await db.sessionRecording.upsert({
        where: { sessionId: session.id },
        update: { status: s.rec },
        create: {
          sessionId: session.id,
          status: s.rec,
          playbackKey: s.rec === 'READY' ? `processed/${session.id}/playback.mp4` : null,
          durationSec: s.rec === 'READY' ? 55 * 60 + 30 : null,
        },
      });
    }
  }

  console.log('Seed complete. Demo password for every account: demo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
