#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ledgerPath = path.join(root, 'docs', 'fork-overlay', 'overlay-ledger.json');

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function ensureFile(filePath) {
  const abs = path.join(root, filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`MISSING FILE: ${filePath}`);
    return null;
  }
  return abs;
}

function ensureDir(dirPath) {
  const abs = path.join(root, dirPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    fail(`MISSING DIR: ${dirPath}`);
    return null;
  }
  return abs;
}

function requireHeading(filePath, heading) {
  const abs = ensureFile(filePath);
  if (!abs) return;
  const content = fs.readFileSync(abs, 'utf8');
  if (!content.includes(heading)) {
    fail(`MISSING HEADING: ${filePath} -> ${heading}`);
  }
}

if (!fs.existsSync(ledgerPath)) {
  fail('MISSING FILE: docs/fork-overlay/overlay-ledger.json');
} else {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

  if (!ledger.version) fail('INVALID LEDGER: version is required');
  if (!Array.isArray(ledger.stableCapabilities) || ledger.stableCapabilities.length === 0) {
    fail('INVALID LEDGER: stableCapabilities must be a non-empty array');
  }
  if (!ledger.sync?.upstreamRemote) fail('INVALID LEDGER: sync.upstreamRemote is required');
  if (!ledger.sync?.upstreamBranch) fail('INVALID LEDGER: sync.upstreamBranch is required');
  if (!Array.isArray(ledger.sync?.replayLayers) || ledger.sync.replayLayers.length === 0) {
    fail('INVALID LEDGER: sync.replayLayers must be a non-empty array');
  }

  ensureFile(ledger.capabilitySpec);
  ensureFile(ledger.changeLog);
  ensureFile(ledger.reportTemplate);
  ensureDir(ledger.reportsDir);

  requireHeading(ledger.capabilitySpec, '# Fork Overlay Capability Spec');
  requireHeading(ledger.changeLog, '# Fork Overlay Change Log');
  requireHeading(ledger.reportTemplate, '# Sync Compatibility Report');

  const ids = new Set();
  for (const capability of ledger.stableCapabilities) {
    if (!capability.id || !capability.title) {
      fail('INVALID LEDGER: each stable capability needs id and title');
      continue;
    }
    if (ids.has(capability.id)) {
      fail(`DUPLICATE CAPABILITY ID: ${capability.id}`);
      continue;
    }
    ids.add(capability.id);
  }

  const layerIds = new Set();
  for (const layer of ledger.sync.replayLayers) {
    if (!layer.id || !layer.title || !Array.isArray(layer.commits)) {
      fail('INVALID LEDGER: each replay layer needs id, title, and commits[]');
      continue;
    }
    if (layerIds.has(layer.id)) {
      fail(`DUPLICATE REPLAY LAYER ID: ${layer.id}`);
      continue;
    }
    layerIds.add(layer.id);
  }
}

if (process.exitCode) {
  console.error('\nOverlay ledger check failed.');
} else {
  console.log('Overlay ledger and documentation structure are valid.');
}
