// StitchHub's "Start a hosted StitchShop / StitchBench" (hub-accounts-billing-design.md 4.4, package hosted-provisioning):
// a bearer PLATFORM_API_TOKEN, a company and its owner made, and a one-time link for the owner's first password. The
// rules (token, https, limits, what is logged) are in src/lib/platform-api.ts. Signed-out by design: the proxy lets
// /api/ through and this route checks its own token; the public links address never serves it (src/lib/links-host.ts).
import { handlePlatformCompanies } from "@/lib/platform-api";

export async function POST(req: Request) {
  return handlePlatformCompanies(req);
}
