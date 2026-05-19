/**
 * Tests for silo-mcp/bootstrap-contract.js — the Stage 2 universal-client
 * contract surface.
 *
 * The pure-data helper (buildBootstrapContract) lives in silo-mcp/ with no
 * MCP SDK / fs imports, so the silo workspace test runner can exercise it
 * directly without silo-mcp/node_modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBootstrapContract,
  CONTRACT_VERSION,
} from '../silo-mcp/bootstrap-contract.js';

// ── shape ──────────────────────────────────────────────────────────────────

test('buildBootstrapContract: top-level keys present', () => {
  const c = buildBootstrapContract();
  for (const k of ['system', 'purpose', 'contract_version', 'capabilities', 'rules', 'memory_model', 'tools']) {
    assert.ok(Object.prototype.hasOwnProperty.call(c, k), `missing key: ${k}`);
  }
});

test('buildBootstrapContract: system + purpose are non-empty strings', () => {
  const c = buildBootstrapContract();
  assert.equal(c.system, 'Silo');
  assert.ok(typeof c.purpose === 'string' && c.purpose.length > 0);
});

test('buildBootstrapContract: contract_version is a semver-shaped string', () => {
  const c = buildBootstrapContract();
  assert.equal(typeof c.contract_version, 'string');
  assert.match(c.contract_version, /^\d+\.\d+$/);
  assert.equal(c.contract_version, CONTRACT_VERSION);
});

// ── capabilities ───────────────────────────────────────────────────────────

test('buildBootstrapContract: capabilities flags the supported surface', () => {
  const { capabilities } = buildBootstrapContract();
  assert.equal(capabilities.bootstrap, true);
  assert.equal(capabilities.search, true);
  assert.equal(capabilities.fetch, true);
  assert.equal(capabilities.write_event, true);
  assert.equal(capabilities.suggestions, true);
  assert.equal(capabilities.notices, true);
  // context_pack uses a version string (not bool) so v1+ can supersede v0
  // without a breaking change to the capabilities shape.
  assert.equal(capabilities.context_pack, 'v0');
});

// ── rules ──────────────────────────────────────────────────────────────────

test('buildBootstrapContract: rules.startup mentions caching', () => {
  const c = buildBootstrapContract();
  assert.match(c.rules.startup.toLowerCase(), /cache/);
});

test('buildBootstrapContract: rules.retrieval_order is ordered + non-empty', () => {
  const c = buildBootstrapContract();
  assert.ok(Array.isArray(c.rules.retrieval_order));
  assert.ok(c.rules.retrieval_order.length >= 3);
  // First call for a vague task should be the context pack; then drill down.
  assert.equal(c.rules.retrieval_order[0], 'silo_context_pack_v0');
  // search ranks last (broadest, includes Layer 3 — should be a fallback).
  assert.equal(c.rules.retrieval_order[c.rules.retrieval_order.length - 1], 'search');
});

test('buildBootstrapContract: rules.do_not lists projection-edit ban', () => {
  const c = buildBootstrapContract();
  assert.ok(Array.isArray(c.rules.do_not));
  const joined = c.rules.do_not.join(' ').toLowerCase();
  assert.match(joined, /projection|write_event/);
  assert.match(joined, /user intent|user approval|explicit/);
});

// ── memory_model ───────────────────────────────────────────────────────────

test('buildBootstrapContract: memory_model describes Zones A/B + Layers 1/2/3', () => {
  const c = buildBootstrapContract();
  assert.ok(c.memory_model.zone_a);
  assert.ok(c.memory_model.zone_b);
  assert.ok(c.memory_model.layers.layer_1);
  assert.ok(c.memory_model.layers.layer_2);
  assert.ok(c.memory_model.layers.layer_3);
  // Zone A must be flagged as the source of truth — clients shouldn't edit it.
  assert.match(c.memory_model.zone_a.toLowerCase(), /append-only|source of truth/);
});

// ── tools ──────────────────────────────────────────────────────────────────

test('buildBootstrapContract: tools catalog covers all current MCP tools', () => {
  const { tools } = buildBootstrapContract();
  const expected = [
    'silo_bootstrap',
    'silo_context_pack_v0',
    'read_index',
    'get_topic',
    'read_events',
    'search',
    'fetch',
    'list_handoffs',
    'list_pending_suggestions',
    'write_event',
    'write_handoff',
    'accept_suggestion',
    'dismiss_suggestion',
  ];
  for (const name of expected) {
    assert.ok(tools[name], `missing tool catalog entry: ${name}`);
    assert.equal(typeof tools[name], 'string');
    assert.ok(tools[name].length > 10, `description too short: ${name}`);
  }
});

test('buildBootstrapContract: write-tool descriptions flag intent requirement', () => {
  const { tools } = buildBootstrapContract();
  for (const writeTool of ['write_event', 'write_handoff', 'accept_suggestion', 'dismiss_suggestion']) {
    const desc = tools[writeTool].toLowerCase();
    assert.match(desc, /write/, `${writeTool} should advertise WRITE posture`);
    assert.match(desc, /user (intent|approval)/, `${writeTool} should require explicit user intent`);
  }
});

// ── serialization ──────────────────────────────────────────────────────────

test('buildBootstrapContract: round-trips through JSON cleanly', () => {
  const c = buildBootstrapContract();
  const round = JSON.parse(JSON.stringify(c));
  assert.deepEqual(round, c);
});

test('buildBootstrapContract: serialized payload is reasonably small', () => {
  // Target ~80 lines / a few KB max. If this fires, the contract has bloated
  // and we should split detail into separate tools (or a v1.x doc page).
  const text = JSON.stringify(buildBootstrapContract(), null, 2);
  assert.ok(text.length < 8000, `contract too large: ${text.length} bytes`);
});
