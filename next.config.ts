import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Skip type checking during build (Vercel handles env vars at runtime)
  typescript: {
    ignoreBuildErrors: false,
  },
  // Disable static export — this is a dynamic app
  output: undefined,
};

export default nextConfig;
