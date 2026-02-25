const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the SDK directory
config.watchFolders = [workspaceRoot];

// Allow resolving from workspace root (for @zvault/sdk)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Configure polyfills for crypto libraries
config.resolver.extraNodeModules = {
  crypto: require.resolve('crypto-browserify'),
  stream: require.resolve('web-streams-polyfill'),
  buffer: require.resolve('buffer'),
};

// Custom resolution for SDK and RN-incompatible modules
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Main SDK entry - use our RN-compatible shim
  if (moduleName === '@zvault/sdk') {
    return {
      filePath: path.resolve(projectRoot, 'lib/sdk-shim.ts'),
      type: 'sourceFile',
    };
  }

  // SDK submodule imports - resolve to SDK src directory
  if (moduleName.startsWith('@zvault/sdk/')) {
    const submodule = moduleName.replace('@zvault/sdk/', '');
    // Handle both foo.ts and foo/index.ts patterns
    const tsPath = path.resolve(workspaceRoot, `sdk/src/${submodule}.ts`);
    const indexPath = path.resolve(workspaceRoot, `sdk/src/${submodule}/index.ts`);
    const fs = require('fs');

    if (fs.existsSync(tsPath)) {
      return {
        filePath: tsPath,
        type: 'sourceFile',
      };
    } else if (fs.existsSync(indexPath)) {
      return {
        filePath: indexPath,
        type: 'sourceFile',
      };
    }
  }

  // Block Node.js-only modules
  const nodeOnlyModules = ['child_process', 'fs', 'path', 'os'];
  if (nodeOnlyModules.includes(moduleName)) {
    return {
      filePath: path.resolve(projectRoot, 'lib/empty-module.js'),
      type: 'sourceFile',
    };
  }

  // Block WASM prover imports (use native snarkjs instead)
  if (moduleName.includes('snarkjs/build/snarkjs.cjs') || moduleName.includes('ffjavascript')) {
    return {
      filePath: path.resolve(projectRoot, 'lib/empty-module.js'),
      type: 'sourceFile',
    };
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
