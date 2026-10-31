-- AlterTable
ALTER TABLE "DecorOrder" ADD COLUMN     "proofAnswer" TEXT,
ADD COLUMN     "proofNo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proofNote" TEXT,
ADD COLUMN     "proofSentAt" TIMESTAMP(3);

