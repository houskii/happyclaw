import type { RegisteredGroup } from './types.js';
import { resolveDefaultLlmBindingFromSystem } from './provider-adapters/registry.js';

export function getDefaultLlmBinding(): Pick<
  RegisteredGroup,
  'llm_provider' | 'model'
> {
  return resolveDefaultLlmBindingFromSystem();
}
