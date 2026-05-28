-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('RECORDING_PIPELINE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'CLAIMED', 'TRANSCODING', 'EXTRACTING_AUDIO', 'UPLOADING_AUDIO', 'THUMBNAIL', 'HANDED_OFF', 'TRANSCRIBING', 'SUMMARIZING', 'COMPLETED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "SessionRecording" ADD COLUMN     "audioKey" TEXT;

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "recordingId" TEXT,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_status_lockedUntil_idx" ON "Task"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "Task_recordingId_idx" ON "Task"("recordingId");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "SessionRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;
