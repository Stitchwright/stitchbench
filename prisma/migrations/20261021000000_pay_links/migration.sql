-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'customer',
ADD COLUMN     "specialOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

