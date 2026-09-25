import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Windows program runs a self-contained copy of the app: STANDALONE=1 npm run build (see desktop/).
  ...(process.env.STANDALONE ? { output: "standalone" as const } : {}),
};

export default nextConfig;
