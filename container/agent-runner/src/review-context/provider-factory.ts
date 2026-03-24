/**
 * Provider Factory — Creates the appropriate ReviewContextProvider from config.
 */

import type { ReviewContextConfig, ReviewContextProvider } from './types.js';
import { NullProvider } from './null-provider.js';
import { PackFileProvider } from './pack-file-provider.js';

export function createProvider(config?: ReviewContextConfig): ReviewContextProvider {
  if (!config || config.provider === 'null') {
    return new NullProvider();
  }

  if (config.provider === 'pack-file') {
    if (!config.options?.root) {
      return new NullProvider(); // No root configured, fall back to null
    }
    return new PackFileProvider(
      config.options.root,
      config.options.maxFileSize,
      config.options.maxTotalSize,
    );
  }

  // Unknown provider type → null (fail-safe)
  return new NullProvider();
}
