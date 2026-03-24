/**
 * Quick fixture verification script.
 * Run: npx tsx src/review-context/__fixtures__/verify-fixtures.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { sanitizeSections } from '../sanitizer.js';
import { shouldInject, selectByBudget, renderContextBlock, assembleContext } from '../prompt-assembler.js';
import type { ReviewContextOutput, ContextSection, PackProvenance } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, name), 'utf-8'));
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

// ─── Test 1: Normal pack → shouldInject = true, renders output ────
{
  const pack = loadFixture<any>('normal-pack.json');
  const sections = pack.sections as ContextSection[];
  const provenance = pack.provenance as PackProvenance;

  const output: ReviewContextOutput = {
    status: 'matched',
    injectable: true,
    candidate_sections: sections,
    provenance,
    matched_service: pack.service,
    generation_id: pack.generation_id,
    provider_diagnostics: [],
  };

  // shouldInject should pass for fresh/high
  assert(shouldInject(output), 'normal pack: shouldInject = true');

  // selectByBudget should include all sections (small fixture)
  const selected = selectByBudget(sections, 2000);
  assert(selected.length === sections.length, `normal pack: all ${sections.length} sections selected`);

  // assembleContext should produce non-empty string
  const block = assembleContext(output, 2000);
  assert(block.length > 0, 'normal pack: assembleContext produces output');
  assert(block.includes('travel_bff'), 'normal pack: output contains service name');
}

// ─── Test 2: Missing sections → shouldInject = false ────
{
  const pack = loadFixture<any>('missing-sections-pack.json');
  const output: ReviewContextOutput = {
    status: 'matched',
    injectable: false,
    candidate_sections: [],
    provenance: pack.provenance,
    matched_service: pack.service,
    generation_id: pack.generation_id,
    provider_diagnostics: [],
  };
  assert(!shouldInject(output), 'missing sections: shouldInject = false');
  assert(assembleContext(output) === '', 'missing sections: assembleContext returns empty');
}

// ─── Test 3: Injection sample → sanitizer catches injections ────
{
  const pack = loadFixture<any>('injection-sample-pack.json');
  const sections = pack.sections as ContextSection[];

  const { sections: sanitized, diagnostics } = sanitizeSections(sections);

  // "hint-with-forbidden" has connection string + private IP → should be dropped
  const forbiddenDropped = !sanitized.some(s => s.id === 'hint-with-forbidden');
  assert(forbiddenDropped, 'injection sample: forbidden-content section dropped');

  // "hint-with-ip" has private IP → should be dropped
  const ipDropped = !sanitized.some(s => s.id === 'hint-with-ip');
  assert(ipDropped, 'injection sample: private-IP section dropped');

  // "risk-with-injection" has injection pattern → text should be filtered
  const injectionSection = sanitized.find(s => s.id === 'risk-with-injection');
  if (injectionSection) {
    assert(!injectionSection.text.includes('IGNORE ALL PREVIOUS'), 'injection sample: injection pattern removed from text');
  }

  // "role-normal" and "hint-clean" should survive
  assert(sanitized.some(s => s.id === 'role-normal'), 'injection sample: normal role survives');
  assert(sanitized.some(s => s.id === 'hint-clean'), 'injection sample: clean hint survives');

  assert(diagnostics.length > 0, `injection sample: ${diagnostics.length} diagnostics emitted`);
}

// ─── Test 4: Corrupted pack → extractPackFields returns null ────
{
  const pack = loadFixture<any>('corrupted-pack.json');
  // Missing schema_minor, provenance, sections → should not be parseable as ServiceContextPack
  assert(!pack.provenance, 'corrupted pack: missing provenance');
  assert(!pack.sections, 'corrupted pack: missing sections');
}

// ─── Test 5: Old schema → schema check ────
{
  const pack = loadFixture<any>('old-schema-pack.json');
  assert(pack.schema_major === 2, 'old schema: major=2 (should be rejected by provider)');
}

console.log('\nFixture verification complete.');
