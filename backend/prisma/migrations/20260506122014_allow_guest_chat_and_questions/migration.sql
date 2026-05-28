-- DropForeignKey
ALTER TABLE "SessionQuestion" DROP CONSTRAINT "SessionQuestion_askedByUserId_fkey";

-- AlterTable
ALTER TABLE "SessionChatMessage" ADD COLUMN     "guestName" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SessionQuestion" ADD COLUMN     "askedGuestName" TEXT,
ALTER COLUMN "askedByUserId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "SessionQuestion" ADD CONSTRAINT "SessionQuestion_askedByUserId_fkey" FOREIGN KEY ("askedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
