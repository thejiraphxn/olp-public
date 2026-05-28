-- Split summary into manual (teacher) + auto (LLM) — same pattern as
-- chapters / autoChapters. Existing AI-generated summaries are preserved by
-- renaming the column; the new `summary` column starts empty so manual
-- overrides come through as nulls until a teacher saves one.
ALTER TABLE "SessionRecording" RENAME COLUMN "summary" TO "autoSummary";
ALTER TABLE "SessionRecording" ADD COLUMN "summary" TEXT;
