-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "coverColor" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "demoBlurb" TEXT,
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "User_isDemo_idx" ON "User"("isDemo");
