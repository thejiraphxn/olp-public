-- Optional 6-digit access code that students/guests must enter before
-- viewing playback or joining a live session. Plaintext on purpose —
-- soft gate, not a security boundary.
ALTER TABLE "CourseSession" ADD COLUMN "accessCode" VARCHAR(6);
