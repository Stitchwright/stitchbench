// Unit tests for telling a part-number clash from any other database error (npm run test:unit). The error shapes are
// what Prisma 7.10 with the pg adapter reported against the dev database when the index on (shopId, lower(partNumber))
// and the schema's own key on the exact number fired.
import test from "node:test";
import assert from "node:assert/strict";

// lib/parts makes the database client as it loads (the client opens no connection until it's used), and the test
// runner doesn't read .env: loaded here, after a stand-in address, as the package is CommonJS (no top-level await).
async function partsLib() {
  process.env.DATABASE_URL ??= "postgresql://unit:unit@localhost:1/unit";
  return import("./parts");
}

const adapterError = (index: string, modelName = "Part") => ({
  name: "PrismaClientKnownRequestError",
  code: "P2002",
  meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index }, table: modelName } }, modelName },
});

test("the lower-case index and the schema's own key are both a part-number clash", async () => {
  const { isPartNumberClash } = await partsLib();
  assert.equal(isPartNumberClash(adapterError("Part_shopId_partNumber_lower_key")), true);
  assert.equal(isPartNumberClash(adapterError("Part_shopId_partNumber_key")), true);
  // Prisma without a driver adapter names the fields instead.
  assert.equal(isPartNumberClash({ code: "P2002", meta: { target: ["shopId", "partNumber"], modelName: "Part" } }), true);
  assert.equal(isPartNumberClash({ code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: ["shopId", "partNumber"] } } }, modelName: "Part" } }), true);
  // A unique violation on Part that names no key can only be the number (the id is made by the program).
  assert.equal(isPartNumberClash({ code: "P2002", meta: { modelName: "Part" } }), true);
});

test("any other error is not one", async () => {
  const { isPartNumberClash } = await partsLib();
  assert.equal(isPartNumberClash(adapterError("Sale_shopId_clientKey_key", "Sale")), false);
  assert.equal(isPartNumberClash({ code: "P2002", meta: { target: ["shopId", "clientKey"], modelName: "Sale" } }), false);
  assert.equal(isPartNumberClash({ code: "P2025", meta: { modelName: "Part" } }), false);
  assert.equal(isPartNumberClash(new Error("connection refused")), false);
  assert.equal(isPartNumberClash(null), false);
  assert.equal(isPartNumberClash(undefined), false);
});
