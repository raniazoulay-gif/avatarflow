// The shared core package lives outside this folder: let Metro watch it.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const coreDir = path.resolve(__dirname, '../../packages/core');
const config = getDefaultConfig(__dirname);
config.watchFolders = [coreDir];
// Files under packages/core resolve their dependencies (babel helpers...) from this app.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

// packages/core is ESM TypeScript with NodeNext ".js" specifiers ("./units.js" -> units.ts).
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && context.originModulePath.startsWith(coreDir)) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // fall through to the original specifier
    }
  }
  return resolve(context, moduleName, platform);
};
module.exports = config;
