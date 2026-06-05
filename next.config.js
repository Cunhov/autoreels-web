/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['./prisma.config.ts'],
  },
  experimental: {},
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
