-- Round 3 review fixes: per-company identity on the hub, the usage report as a setting, removed cross-reference
-- entries kept so they can be put back, and one form of each barcode.

-- The company on the other install that shared a note or listed an item (from hubs that say).
ALTER TABLE "HubPost" ADD COLUMN     "shopRef" TEXT;

ALTER TABLE "Listing" ADD COLUMN     "sellerRef" TEXT;

-- The monthly most-used-parts report to the hub is each company's choice, off unless turned on.
ALTER TABLE "Shop" ADD COLUMN     "shareUsage" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RemovedXPart" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "numbers" JSONB NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemovedXPart_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RemovedXPart_removedAt_idx" ON "RemovedXPart"("removedAt");

-- A barcode stored as UPC-A (12 digits, or 11 once a spreadsheet dropped the leading 0) or EAN-13 also gets its
-- 14-digit form, so a scanner sending another form of the same code finds the item (new and edited items get it too).
UPDATE "Part" p SET "numberKeys" = (
  SELECT array_agg(DISTINCT k ORDER BY k) FROM (
    SELECT unnest(p."numberKeys") AS k
    UNION SELECT lpad(k2, 14, '0') FROM unnest(p."numberKeys") AS k2 WHERE k2 ~ '^[0-9]{11,13}$'
  ) s
)
WHERE EXISTS (SELECT 1 FROM unnest(p."numberKeys") AS k WHERE k ~ '^[0-9]{11,13}$');
