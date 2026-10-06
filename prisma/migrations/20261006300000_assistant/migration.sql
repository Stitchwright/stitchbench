-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "assistantCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "assistantLimit" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "assistantMonth" TEXT;

-- CreateTable
CREATE TABLE "AssistantSettings" (
    "shopId" TEXT NOT NULL,
    "draftOn" BOOLEAN NOT NULL DEFAULT true,
    "causesOn" BOOLEAN NOT NULL DEFAULT true,
    "plateOn" BOOLEAN NOT NULL DEFAULT true,
    "offerFirstNames" BOOLEAN NOT NULL DEFAULT false,
    "voice" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "AssistantCall" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "machineId" TEXT,
    "partId" TEXT,
    "byUserId" TEXT,
    "model" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMillicents" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "accepted" BOOLEAN,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantCall_shopId_createdAt_idx" ON "AssistantCall"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantCall_shopId_ticketId_idx" ON "AssistantCall"("shopId", "ticketId");

-- AddForeignKey
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantCall" ADD CONSTRAINT "AssistantCall_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

