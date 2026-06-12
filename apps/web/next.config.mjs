import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === "production" ? ".next-build" : ".next-dev");

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  outputFileTracingRoot: workspaceRoot
};

export default nextConfig;
