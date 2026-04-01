#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ledgerPath = path.join(root, 'docs', 'fork-overlay', 'overlay-ledger.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');

function git(...gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hasRemote(name) {
  const remotes = git('remote').split('\n').filter(Boolean);
  return remotes.includes(name);
}

function printStep(title, detail) {
  console.log(`- ${title}: ${detail}`);
}

const remoteExists = hasRemote(ledger.sync.upstreamRemote);
if (!remoteExists && execute) {
  console.error(`Missing git remote "${ledger.sync.upstreamRemote}". Add it before rebuilding overlay.`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const rebuildBranch = `${ledger.sync.overlayRebuildBranchPrefix}/${timestamp}`;
const upstreamRef = `${ledger.sync.upstreamRemote}/${ledger.sync.upstreamBranch}`;

console.log(`Overlay rebuild mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
printStep('upstream base', upstreamRef);
printStep('rebuild branch', rebuildBranch);
printStep('promotion branch', ledger.sync.promotionBranch);
if (!remoteExists) {
  printStep('warning', `git remote "${ledger.sync.upstreamRemote}" is missing in the current repository`);
}

for (const layer of ledger.sync.replayLayers) {
  const commits = layer.commits.length > 0 ? layer.commits.join(', ') : '(none)';
  printStep(`replay layer ${layer.id}`, `${layer.title} -> ${commits}`);
}

if (!execute) {
  console.log('\nNo git state was changed. Re-run with --execute to create the rebuild branch and replay layers.');
  process.exit(0);
}

git('fetch', ledger.sync.upstreamRemote, ledger.sync.upstreamBranch);
git('switch', '--create', rebuildBranch, upstreamRef);

for (const layer of ledger.sync.replayLayers) {
  if (layer.commits.length === 0) continue;
  console.log(`\nReplaying layer: ${layer.id} (${layer.title})`);
  for (const commit of layer.commits) {
    console.log(`  cherry-pick ${commit}`);
    git('cherry-pick', commit);
  }
}

console.log(`\nOverlay rebuild completed on branch ${rebuildBranch}`);
console.log(`Next step: write a sync compatibility report in ${ledger.reportsDir}`);
