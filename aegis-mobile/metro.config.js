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

// Polyfill Node.js built-ins for SDK transitive deps (circomlibjs/ffjavascript)
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  assert: require.resolve("assert"),
  buffer: require.resolve("buffer"),
  crypto: require.resolve("crypto-browserify"),
  events: require.resolve("events"),
  os: require.resolve("os-browserify/browser"),
  process: require.resolve("process/browser"),
  stream: require.resolve("stream-browserify"),
  string_decoder: require.resolve("string_decoder"),
  vm: require.resolve("vm-browserify"),
};

// Force-shim modules that exist in node_modules but break in React Native
const shimmedModules = {
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
