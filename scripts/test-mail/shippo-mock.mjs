// A stand-in for the bits of Shippo the shipping labels use (shop-features-round-2-design.md 9.5). node:http only; never
// a real label or real money. Point SHIPPO_API_BASE at it.
//
//   import { startShippoMock } from "./shippo-mock.mjs"; const mock = await startShippoMock({ port: 0 });
//   node scripts/test-mail/shippo-mock.mjs        // SHIPPO_MOCK_PORT (3405)
//
// "Authorization: ShippoToken shippo_test_..." only. POST /shipments/ (JSON: address_from, address_to, parcels, async
// false) answers three rates (USPS Ground Advantage, USPS Priority, UPS Ground; an address_to with zip 00000 is refused
// as an invalid address); GET /rates/{id}; POST /transactions/ (rate, label_file_type) buys one: a tracking number and a
// label address.
// Test hooks: GET /__shipments, GET /__transactions, DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hex = (n) => crypto.randomBytes(n).toString("hex");
const readJson = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** @param {{ port?: number }} o */
export async function startShippoMock(o = {}) {
  const shipments = new Map();
  const rates = new Map();
  const transactions = [];
  let port = o.port ?? Number(process.env.SHIPPO_MOCK_PORT ?? 3405);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname.replace(/\/$/, "");
    if (p === "/__shipments") return json(res, 200, [...shipments.values()]);
    if (p === "/__transactions") return json(res, 200, transactions);
    if (p === "/__state" && req.method === "DELETE") {
      shipments.clear();
      rates.clear();
      transactions.length = 0;
      return json(res, 200, { ok: true });
    }
    if (!/^ShippoToken shippo_test_[A-Za-z0-9]{8,}$/.test(req.headers.authorization ?? "")) return json(res, 401, { detail: "Invalid token." });
    if (p === "/shipments" && req.method === "POST") {
      const b = await readJson(req);
      const to = b.address_to ?? {};
      if (!to.street1 || !to.city || !to.state || !to.zip) return json(res, 400, { address_to: ["This field is required."] });
      const id = `shp_${hex(8)}`;
      const invalid = to.zip === "00000";
      const list = invalid
        ? []
        : [
            { amount: "5.40", provider: "USPS", servicelevel: { name: "Ground Advantage", token: "usps_ground_advantage" }, estimated_days: 4 },
            { amount: "9.85", provider: "USPS", servicelevel: { name: "Priority Mail", token: "usps_priority" }, estimated_days: 2 },
            { amount: "11.20", provider: "UPS", servicelevel: { name: "Ground", token: "ups_ground" }, estimated_days: 3 },
          ].map((r) => ({ ...r, object_id: `rate_${hex(8)}`, shipment: id, currency: "USD" }));
      for (const r of list) rates.set(r.object_id, r);
      const s = { object_id: id, status: "SUCCESS", address_from: b.address_from, address_to: to, parcels: b.parcels, rates: list, messages: invalid ? [{ source: "USPS", text: "Address not found." }] : [] };
      shipments.set(id, s);
      return json(res, 201, s);
    }
    const rm = /^\/rates\/(rate_\w+)$/.exec(p);
    if (rm && req.method === "GET") {
      const r = rates.get(rm[1]);
      return r ? json(res, 200, r) : json(res, 404, { detail: "Not found." });
    }
    if (p === "/transactions" && req.method === "POST") {
      const b = await readJson(req);
      const r = rates.get(b.rate);
      if (!r) return json(res, 400, { rate: ["Invalid rate."] });
      const t = { object_id: `tx_${hex(8)}`, status: "SUCCESS", rate: r.object_id, tracking_number: `9400${hex(8).toUpperCase()}`, label_url: `http://127.0.0.1:${port}/labels/${hex(6)}.pdf`, messages: [] };
      transactions.push(t);
      return json(res, 201, t);
    }
    return json(res, 404, { detail: "Not found." });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  port = server.address().port;
  return { port, shipments, transactions, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startShippoMock().then((m) => console.log(`Shippo mock on http://127.0.0.1:${m.port} (SHIPPO_API_BASE)`));
}
