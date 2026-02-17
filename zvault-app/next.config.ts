import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  transpilePackages: ["@zvault/sdk"],
  webpack: (config, { isServer }) => {
    // Enable symlinks for bun workspace compatibility
    config.resolve.symlinks = true;
    config.experiments = {
      ...config.experiments,
      topLevelAwait: true,
    };
    if (!isServer) {
      config.output = {
        ...config.output,
        environment: {
          ...config.output?.environment,
          asyncFunction: true,
        },
      };
      // Polyfill Node.js modules for browser
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        child_process: false,
        crypto: false,
        stream: false,
        os: false,
        net: false,
        tls: false,
        http: false,
        https: false,
        zlib: false,
      };
    }
    return config;
  },
};

export default nextConfig;
