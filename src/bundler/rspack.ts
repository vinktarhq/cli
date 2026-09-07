/**
 * rspack reimplements webpack's plugin API — `thisCompilation`, `processAssets`, the stage
 * constants and `compilation.updateAsset` all behave the same way — so the plugin is the same
 * plugin. This module exists so an rspack config can say `vinktarRspack` and read correctly,
 * rather than importing something called "webpack" into a build that is not one.
 */
export { VinktarWebpackPlugin as VinktarRspackPlugin, vinktarWebpack as vinktarRspack } from './webpack.js';
export type { BundlerOptions } from './core.js';
