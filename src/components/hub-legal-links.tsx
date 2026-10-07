// StitchHub's Terms of Service and Privacy Policy, linked from the login and sign-up pages when this install is on a hub
// (hub-accounts-billing-design.md 4.2, package terms-launch); nothing on an install that isn't. The hub's /terms and
// /privacy always show the version in force.
import { checkHubUrl, hubState } from "@/lib/hub";

export async function HubLegalLinks() {
  const s = await hubState().catch(() => null);
  if (!s?.url || !s.installKey) return null;
  let base: string;
  try {
    base = checkHubUrl(s.url);
  } catch {
    return null;
  }
  return (
    <p className="muted text-center text-xs">
      <a href={`${base}/terms`} target="_blank" rel="noreferrer" className="link">
        Terms of Service
      </a>
      {" · "}
      <a href={`${base}/privacy`} target="_blank" rel="noreferrer" className="link">
        Privacy Policy
      </a>
    </p>
  );
}
