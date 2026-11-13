import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  reactStrictMode: true,
  // Local development only: `vercel dev` can't load the Python API on macOS
  // (pydantic_core native module error), so in dev we proxy /api to a FastAPI
  // server you run yourself with uvicorn on port 8000. On Vercel, NODE_ENV is
  // "production" and the Python function serves /api as before.
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      { source: "/api", destination: "http://127.0.0.1:8000/api" },
      { source: "/api/ideas", destination: "http://127.0.0.1:8000/api/ideas" },
    ];
  },
};

export default nextConfig;
