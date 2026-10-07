-- AlterTable
ALTER TABLE "CompanyMove" ADD COLUMN     "hubCursors" JSONB,
ADD COLUMN     "hubDoneAt" TIMESTAMP(3),
ADD COLUMN     "hubError" TEXT,
ADD COLUMN     "hubTokenSealed" TEXT,
ADD COLUMN     "hubUrl" TEXT;

