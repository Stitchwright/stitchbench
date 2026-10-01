-- Round-3 tail 2: partners and the hub connection (M53, M58, L136).

-- The connection this install left, so joining the same hub again keeps the same install (its listings, orders and
-- shared notes stay its own).
ALTER TABLE "HubState" ADD COLUMN     "formerUrl" TEXT,
ADD COLUMN     "formerInstallId" TEXT,
ADD COLUMN     "formerInstallKey" TEXT;

-- A proposal taken as agreed can be put back if the partner had replaced it before the acceptance arrived; the
-- withdrawn one is kept aside to show.
ALTER TABLE "PartnerLink" ADD COLUMN     "priorTerms" JSONB,
ADD COLUMN     "withdrawnTerms" JSONB;

-- A set-aside message's number on the hub, so it can be fetched whole and applied once more.
ALTER TABLE "PartnerFailure" ADD COLUMN     "seq" TEXT;
