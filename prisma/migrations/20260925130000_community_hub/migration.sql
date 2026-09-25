-- AlterTable
ALTER TABLE "SharedPost" ADD COLUMN     "hubId" TEXT;

-- CreateTable
CREATE TABLE "ManualLink" (
    "id" TEXT NOT NULL,
    "category" TEXT,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "modelKeys" TEXT[],
    "docType" TEXT,
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "url" TEXT NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unchecked',
    "httpStatus" INTEGER,
    "checkedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubPost" (
    "id" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "authorName" TEXT,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL DEFAULT 'GOTCHA',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mine" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubPhoto" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "PhotoKind" NOT NULL,
    "caption" TEXT,
    "mime" TEXT NOT NULL,
    "data" BYTEA,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HubPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubFigure" (
    "id" TEXT NOT NULL,

    CONSTRAINT "HubFigure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "url" TEXT,
    "installId" TEXT,
    "installKey" TEXT,
    "joinedAt" TIMESTAMP(3),
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "HubState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualLink_modelKeys_idx" ON "ManualLink" USING GIN ("modelKeys");

-- CreateIndex
CREATE INDEX "ManualLink_brand_idx" ON "ManualLink"("brand");

-- CreateIndex
CREATE INDEX "HubPost_modelKey_idx" ON "HubPost"("modelKey");

-- CreateIndex
CREATE INDEX "HubPhoto_postId_idx" ON "HubPhoto"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedPost_hubId_key" ON "SharedPost"("hubId");

-- AddForeignKey
ALTER TABLE "HubPhoto" ADD CONSTRAINT "HubPhoto_postId_fkey" FOREIGN KEY ("postId") REFERENCES "HubPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

