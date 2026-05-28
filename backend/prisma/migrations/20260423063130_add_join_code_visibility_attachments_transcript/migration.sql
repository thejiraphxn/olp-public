/*
  Warnings:

  - A unique constraint covering the columns `[joinCode]` on the table `Course` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `joinCode` to the `Course` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CourseVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- AlterTable
-- Add as nullable first
ALTER TABLE "Course"
  ADD COLUMN "joinCode" TEXT,
  ADD COLUMN "visibility" "CourseVisibility" NOT NULL DEFAULT 'PRIVATE';

-- Backfill a random 6-char upper-case code for every existing row
UPDATE "Course"
SET "joinCode" = UPPER(SUBSTRING(MD5(RANDOM()::TEXT || id) FROM 1 FOR 6))
WHERE "joinCode" IS NULL;

-- Enforce NOT NULL now that every row has a value
ALTER TABLE "Course" ALTER COLUMN "joinCode" SET NOT NULL;


-- AlterTable
ALTER TABLE "SessionChatMessage" ADD COLUMN     "attachmentKey" TEXT,
ADD COLUMN     "attachmentMimeType" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentSize" INTEGER;

-- AlterTable
ALTER TABLE "SessionRecording" ADD COLUMN     "transcript" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Course_joinCode_key" ON "Course"("joinCode");

-- CreateIndex
CREATE INDEX "Course_visibility_idx" ON "Course"("visibility");
