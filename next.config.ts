import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Windows program runs a self-contained copy of the app: STANDALONE=1 npm run build (see desktop/).
  ...(process.env.STANDALONE ? { output: "standalone" as const } : {}),
  // Machine intake and marketplace listings send their photos with the form (shrunk in the browser first). Every page
  // request passes proxy.ts, which buffers at most proxyClientMaxBodySize (10 MB unless raised) and hands the action a
  // cut-off body beyond it: the two limits have to be the same.
  experimental: { serverActions: { bodySizeLimit: "16mb" }, proxyClientMaxBodySize: "16mb" },
};

export default nextConfig;
