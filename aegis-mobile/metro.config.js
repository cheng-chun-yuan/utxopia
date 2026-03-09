const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the SDK workspace
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Polyfill Node.js built-ins that transitive deps may reference
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  buffer: require.resolve("buffer"),
  process: require.resolve("process/browser"),
};

// Force-shim modules that exist in node_modules but break in React Native
const shimmedModules = {
  "circomlibjs": path.resolve(projectRoot, "shims/empty.js"),
  "snarkjs": path.resolve(projectRoot, "shims/empty.js"),
  "web-worker": path.resolve(projectRoot, "shims/empty.js"),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (shimmedModules[moduleName]) {
    return { type: "sourceFile", filePath: shimmedModules[moduleName] };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
