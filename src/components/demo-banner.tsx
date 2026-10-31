// The strip across the top of a demo server (DEMO_MODE=on, docs/demo.md): what this is, and the way to the beta.
// Server component: it is only rendered when the layout sees isDemo(). DEMO_SIGNUP_URL changes where "Join the beta" goes.
const SIGNUP = process.env.DEMO_SIGNUP_URL?.trim() || "https://stitchbench.app/signup/";

export function DemoBanner() {
  return (
    <div role="note" className="no-print bg-navy px-4 py-2 text-center text-sm text-navy-ink" data-testid="demo-banner">
      <strong>Demo shop</strong> with invented people, resets every night. Change anything you like.{" "}
      <a href={SIGNUP} className="font-semibold underline">
        Like it? Join the beta
      </a>
    </div>
  );
}
