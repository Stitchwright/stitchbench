-- Round 3 (low findings), indexes on the lookups every ticket page, sale page and report makes. Postgres doesn't index
-- foreign keys by itself, and these tables hold every company's rows on a hosted install, so each page load and cascade
-- delete scanned them all. Plain CREATE INDEX (not CONCURRENTLY): a migration runs in one transaction, and these tables are
-- small enough that building them takes moments.

-- CreateIndex
CREATE INDEX "Machine_customerId_idx" ON "Machine"("customerId");

-- CreateIndex
CREATE INDEX "Ticket_machineId_idx" ON "Ticket"("machineId");

-- CreateIndex
CREATE INDEX "Ticket_customerId_idx" ON "Ticket"("customerId");

-- CreateIndex
CREATE INDEX "Ticket_viaAccountId_idx" ON "Ticket"("viaAccountId");

-- CreateIndex
CREATE INDEX "TicketLine_ticketId_idx" ON "TicketLine"("ticketId");

-- CreateIndex
CREATE INDEX "Payment_ticketId_idx" ON "Payment"("ticketId");

-- CreateIndex
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");

-- CreateIndex
CREATE INDEX "ServiceItem_shopId_idx" ON "ServiceItem"("shopId");

-- CreateIndex
CREATE INDEX "StockMove_partId_createdAt_idx" ON "StockMove"("partId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMove_shopId_createdAt_idx" ON "StockMove"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE INDEX "PartnerOutbox_shopId_linkId_sentAt_idx" ON "PartnerOutbox"("shopId", "linkId", "sentAt");
