-- CreateTable
CREATE TABLE "ShopOrdersSync" (
    "shopId" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "maxOpen" INTEGER NOT NULL DEFAULT 200,
    "cursor" TEXT NOT NULL DEFAULT '0',
    "helloAt" TIMESTAMP(3),
    "lastPollAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "upgradeNeeded" TEXT,
    "catalogPublishedAt" TIMESTAMP(3),

    CONSTRAINT "ShopOrdersSync_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "SyncIn" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "conversation" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "result" TEXT,
    "appliedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "nextTryAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "SyncIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncInSeq" (
    "shopId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "conversation" TEXT NOT NULL,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,
    "gapped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SyncInSeq_pkey" PRIMARY KEY ("shopId","sender","conversation")
);

-- CreateTable
CREATE TABLE "SyncOut" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversation" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "nextTryAt" TIMESTAMP(3),
    "error" TEXT,
    "deadAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "expiredWhy" TEXT,

    CONSTRAINT "SyncOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncOutSeq" (
    "shopId" TEXT NOT NULL,
    "conversation" TEXT NOT NULL,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SyncOutSeq_pkey" PRIMARY KEY ("shopId","conversation")
);

-- CreateIndex
CREATE INDEX "SyncIn_shopId_appliedAt_sender_conversation_idx" ON "SyncIn"("shopId", "appliedAt", "sender", "conversation");

-- CreateIndex
CREATE UNIQUE INDEX "SyncIn_shopId_messageId_key" ON "SyncIn"("shopId", "messageId");

-- CreateIndex
CREATE INDEX "SyncOut_shopId_sentAt_deadAt_idx" ON "SyncOut"("shopId", "sentAt", "deadAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncOut_shopId_conversation_seq_key" ON "SyncOut"("shopId", "conversation", "seq");

-- AddForeignKey
ALTER TABLE "ShopOrdersSync" ADD CONSTRAINT "ShopOrdersSync_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

