/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    // Prevent prisma.config.ts from being included in the standalone output.
    // When included, `npx prisma` in the entrypoint finds and tries to load it,
    // but the standalone container doesn't have the full node_modules to resolve `prisma/config`.
    outputFileTracingExcludes: {
      '*': ['./prisma.config.ts'],
    },
  },
};

module.exports = nextConfig;
