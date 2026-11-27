import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseTier, looksIntegrated, TIERS } from './tier.ts';

const discrete = { vendor: 'nvidia', architecture: 'ampere', description: 'NVIDIA GeForce RTX 3050' };
const integrated = { vendor: 'intel', architecture: 'gen-12lp', description: 'Intel(R) UHD Graphics' };

// ---------- looksIntegrated ----------

test('an Intel integrated adapter is recognised', () => {
  assert.equal(looksIntegrated(integrated), true);
});

test('an NVIDIA adapter is not integrated', () => {
  assert.equal(looksIntegrated(discrete), false);
});

test('an AMD Radeon RX adapter is not integrated', () => {
  assert.equal(looksIntegrated({ vendor: 'amd', description: 'AMD Radeon RX 6600' }), false);
});

test('AMD integrated graphics are recognised', () => {
  assert.equal(looksIntegrated({ vendor: 'amd', description: 'AMD Radeon(TM) Vega 8 Graphics' }), true);
});

test('an Apple adapter is not treated as integrated', () => {
  // Apple silicon shares memory but is not a weak GPU.
  assert.equal(looksIntegrated({ vendor: 'apple', description: 'Apple M2' }), false);
});

test('an unknown adapter is not assumed integrated', () => {
  assert.equal(looksIntegrated({}), false);
});

// ---------- chooseTier ----------

test('without WebGPU the slowest tier is chosen', () => {
  const choice = chooseTier({ hasWebGpu: false });
  assert.equal(choice.tier, 'C');
  assert.match(choice.reason, /webgpu/i);
});

test('a discrete GPU gets the most accurate tier', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: discrete });
  assert.equal(choice.tier, 'A');
  assert.equal(choice.model, TIERS.A.model);
});

test('a discrete GPU needs no warning', () => {
  assert.equal(chooseTier({ hasWebGpu: true, adapter: discrete }).warning, undefined);
});

test('an integrated GPU drops a tier', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: integrated });
  assert.equal(choice.tier, 'B');
});

test('an integrated GPU warns that Chrome may have picked the wrong one', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: integrated });
  assert.match(choice.warning ?? '', /high performance|graphics settings/i);
});

test('an unknown adapter is treated conservatively', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: null });
  assert.equal(choice.tier, 'B');
});

test('a measured speed overrides the guess from the adapter name', () => {
  // The adapter says integrated, but it actually runs well.
  const choice = chooseTier({ hasWebGpu: true, adapter: integrated, benchmarkRealtime: 3.5 });
  assert.equal(choice.tier, 'A');
  assert.match(choice.reason, /measured/i);
});

test('a slow measurement overrides a promising adapter name', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: discrete, benchmarkRealtime: 0.4 });
  assert.equal(choice.tier, 'C');
  assert.match(choice.reason, /measured/i);
});

test('a measurement around realtime picks the middle tier', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: discrete, benchmarkRealtime: 1.4 });
  assert.equal(choice.tier, 'B');
});

test('a discrete adapter running slowly is warned about explicitly', () => {
  const choice = chooseTier({ hasWebGpu: true, adapter: discrete, benchmarkRealtime: 0.5 });
  assert.match(choice.warning ?? '', /high performance|graphics settings/i);
});

test('the chosen tier always names a model to load', () => {
  for (const benchmarkRealtime of [0.1, 1.0, 5.0, undefined]) {
    const choice = chooseTier({ hasWebGpu: true, adapter: discrete, benchmarkRealtime });
    assert.ok(choice.model.length > 0, `tier ${choice.tier} has no model`);
  }
});

test('every tier is described for the panel', () => {
  for (const [name, tier] of Object.entries(TIERS)) {
    assert.ok(tier.model.length > 0, `${name} has no model`);
    assert.ok(tier.label.length > 0, `${name} has no label`);
  }
});
