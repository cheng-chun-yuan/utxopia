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

// Polyfill Node.js built-ins for SDK transitive deps (circomlibjs)
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  assert: require.resolve("assert"),
  buffer: require.resolve("buffer"),
  process: require.resolve("process/browser"),
};

module.exports = withNativeWind(config, { input: "./global.css" });
