-- CreateTable
CREATE TABLE "OffsiteSettings" (
    "shopId" TEXT NOT NULL,
    "on" BOOLEAN NOT NULL DEFAULT false,
    "target" TEXT NOT NULL DEFAULT 'hub',
    "folderPath" TEXT NOT NULL DEFAULT '',
    "bucket" JSONB,
    "publicKey" TEXT,
    "keyId" TEXT,
    "keyMadeAt" TIMESTAMP(3),
    "keyCheckedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OffsiteSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "OffsiteObject" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "photoTable" TEXT,
    "photoId" TEXT,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "goneAt" TIMESTAMP(3),

    CONSTRAINT "OffsiteObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffsiteRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "photos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "OffsiteRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OffsiteObject_shopId_kind_uploadedAt_idx" ON "OffsiteObject"("shopId", "kind", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OffsiteObject_shopId_name_key" ON "OffsiteObject"("shopId", "name");

-- CreateIndex
CREATE INDEX "OffsiteRun_shopId_startedAt_idx" ON "OffsiteRun"("shopId", "startedAt");

-- AddForeignKey
ALTER TABLE "OffsiteSettings" ADD CONSTRAINT "OffsiteSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

