// The parsers behind the tray's "Secure address for tablets (Tailscale)" item (tailscale.mjs). No Tailscale needed.
import test from "node:test";
import assert from "node:assert/strict";
import { dnsNameOf, summarizeStatus, readServeConfig, linkIn } from "../tailscale.mjs";

test("status: the device's DNS name loses its trailing dot, and https is on when CertDomains names it", () => {
  const status = { BackendState: "Running", Self: { DNSName: "Shop-PC.tail1234.ts.net." }, CertDomains: ["shop-pc.tail1234.ts.net"] };
  assert.equal(dnsNameOf(status), "shop-pc.tail1234.ts.net");
  assert.deepEqual(summarizeStatus(status), { running: true, state: "Running", dnsName: "shop-pc.tail1234.ts.net", httpsEnabled: true });
  assert.deepEqual(summarizeStatus({ ...status, CertDomains: [] }).httpsEnabled, false);
  assert.deepEqual(summarizeStatus({ BackendState: "NeedsLogin" }), { running: false, state: "NeedsLogin", dnsName: "", httpsEnabled: false });
  assert.equal(summarizeStatus(null).running, false);
});

test("serve config: on when / on :443 proxies to our port; funnel on :443 is flagged; no config is off", () => {
  const cfg = { TCP: { 443: { HTTPS: true } }, Web: { "shop-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } } } };
  assert.deepEqual(readServeConfig(JSON.stringify(cfg), 3100), { on: true, target: "http://127.0.0.1:3100", funnel: false });
  assert.equal(readServeConfig(cfg, 3110).on, false); // StitchShop's port: another program's serve isn't ours
  assert.equal(readServeConfig({ ...cfg, Web: { "shop-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3100" } } } } }, 3100).on, true);
  assert.equal(readServeConfig({ ...cfg, Web: { "shop-pc.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } } } }, 3100).on, false);
  assert.equal(readServeConfig({ ...cfg, AllowFunnel: { "shop-pc.tail1234.ts.net:443": true } }, 3100).funnel, true);
  assert.equal(readServeConfig({ ...cfg, AllowFunnel: { "shop-pc.tail1234.ts.net:8443": true } }, 3100).funnel, false);
  assert.deepEqual(readServeConfig("No serve config", 3100), { on: false, target: "", funnel: false });
  assert.deepEqual(readServeConfig("", 3100), { on: false, target: "", funnel: false });
});

test("linkIn: the approval link in a CLI message, without a trailing full stop", () => {
  assert.equal(linkIn("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=abc.\n"), "https://login.tailscale.com/f/serve?node=abc");
  assert.equal(linkIn("error enabling https feature: something"), null);
  assert.equal(linkIn(undefined), null);
});
