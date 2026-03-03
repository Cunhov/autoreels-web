/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['./prisma.config.ts'],
  },
  experimental: {},
};

module.exports = nextConfig;
