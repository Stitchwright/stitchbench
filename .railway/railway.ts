// Railway Infrastructure as Code for the hosted services deployed from this folder: project `stitchshop` (service
// `stitchshop`) and project `stitchbench` (service `stitchbench`). It carries the same settings as railway.json
// (Config as Code, which Railway stops reading on 2026-12-01). Railway does not read this file on `railway up`: it is
// applied once per project with `railway config plan` and `railway config apply` while the folder is linked to that
// project. One file serves both projects because the CLI passes the linked
// project's name in `ctx`, and in both projects the service carries the project's name (INSTALL.md's self-hosted
// setup, `railway init --name stitchbench` + service `stitchbench`, follows the same rule).
//
// Variables: Railway deletes every variable of a declared service that the file leaves out, so each one the services
// hold is listed here with preserve() ("keep the value Railway already has"). When a variable is added in the
// dashboard (PUBLIC_URL, SETTINGS_KEY, the Stripe keys...), add its name here first, or `railway config plan` will
// list it under "to destroy". The plan must read "0 to destroy" before `railway config apply`.
import { defineRailway, preserve, project, service } from "railway/iac";

// This repository manages only the app service of each project. The Postgres database is not declared here and stays
// as it is: without a partial name, a resource missing from this file would be deleted on apply.
export const partial = "app";

const keptVariables = [
  "APP_NAME",
  "AUTH_SECRET",
  "AUTH_TRUST_HOST",
  "DATABASE_URL",
  "DEFAULT_SHOP_KIND",
  "FOUNDRY_CLOUD_URL",
  "FOUNDRY_SIGNIN",
  "FOUNDRY_AI",
  "FOUNDRY_AI_FALLBACK_MODEL",
  "PLATFORM_ADMIN_EMAILS",
  // Not set on either service as of 2 Oct 2026, but needed for customer links (booking, the shop) and for sealing the
  // mail password and Stripe keys: listed so that setting them in the dashboard never shows up as "to destroy".
  "PUBLIC_URL",
  "SETTINGS_KEY",
  "SEED_OWNER_EMAIL",
  "SEED_OWNER_NAME",
  "SEED_OWNER_PASSWORD",
  "SEED_SHOP_NAME",
  // The manufacturers' reference data, fetched at build time from the private data repository
  // (scripts/data/fetch-reference-data.mjs): the token, and the repository and branch if they aren't the defaults.
  "STITCH_DATA_TOKEN",
  "STITCH_DATA_REPO",
  "STITCH_DATA_REF",
  "TRUST_PROXY",
];

export default defineRailway((ctx) => {
  const name = ctx.projectName;
  if (!name) {
    throw new Error("Link this folder to the Railway project first (railway link --project stitchshop or stitchbench)");
  }
  const app = service(name, {
    deploy: {
      healthcheckPath: "/api/health",
      healthcheckTimeout: 600,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: Object.fromEntries(keptVariables.map((key) => [key, preserve()])),
  });
  return project(name, { resources: [app] });
});
