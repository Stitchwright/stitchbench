-- AlterTable
ALTER TABLE "AssistantSettings" ADD COLUMN     "aiSource" TEXT NOT NULL DEFAULT 'foundry',
ADD COLUMN     "ownKey" TEXT;

-- AlterTable
ALTER TABLE "AssistantCall" ADD COLUMN     "credits" INTEGER;
