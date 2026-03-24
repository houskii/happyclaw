/**
 * Review Context — Public API
 *
 * Usage:
 *   import { createProvider, assembleContext } from './review-context/index.js';
 *   const provider = createProvider(config);
 *   const output = await provider.provide({ repoPath, changedFiles });
 *   const contextBlock = assembleContext(output, maxTokens);
 */

export { createProvider } from './provider-factory.js';
export { assembleContext, shouldInject, selectByBudget, renderContextBlock } from './prompt-assembler.js';
export { sanitizeSections } from './sanitizer.js';
export { NullProvider } from './null-provider.js';
export { PackFileProvider } from './pack-file-provider.js';

export type {
  ReviewContextProvider,
  ReviewContextInput,
  ReviewContextOutput,
  ReviewContextConfig,
  ReviewContextStatus,
  ServiceContextPack,
  PackProvenance,
  ContextSection,
  Manifest,
  ManifestEntry,
  ServiceIdentifiers,
  Diagnostic,
  DiagnosticCode,
  FreshnessState,
  ConfidenceLevel,
} from './types.js';
