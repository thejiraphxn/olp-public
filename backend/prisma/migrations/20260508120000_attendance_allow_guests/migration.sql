-- Allow guests (no User row) to be tracked in SessionAttendance.
-- userId becomes nullable + new guestName column for the JWT snapshot.

-- Drop the existing FK so we can relax NOT NULL on userId.
ALTER TABLE "SessionAttendance"
  DROP CONSTRAINT IF EXISTS "SessionAttendance_userId_fkey";

ALTER TABLE "SessionAttendance"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "guestName" TEXT;

-- Re-add FK as nullable (matches Prisma `user User? @relation(...)`).
ALTER TABLE "SessionAttendance"
  ADD CONSTRAINT "SessionAttendance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
