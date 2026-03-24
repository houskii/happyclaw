/**
 * Null Provider — Default when no review context is configured.
 * Returns not_configured status with zero overhead.
 */

import type { ReviewContextProvider, ReviewContextInput, ReviewContextOutput } from './types.js';

export class NullProvider implements ReviewContextProvider {
  name = 'null';

  async provide(_input: ReviewContextInput): Promise<ReviewContextOutput> {
    return {
      status: 'not_configured',
      injectable: false,
      provider_diagnostics: [],
    };
  }
}
