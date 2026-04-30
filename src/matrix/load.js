/**
 * Event Capability Matrix loader — v12.5 §4.7.
 *
 * Loads matrix.yaml, validates structure, exposes admission oracle.
 * This is the SINGLE source of truth for event admission per v12.5.
 * §19 spec invariant: every admissible event type has a row here;
 * unlisted event types are rejected with UNKNOWN_EVENT_TYPE_NOT_REGISTERED.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX_PATH = join(__dirname, 'matrix.yaml');

const BROKER_MODES = ['standard', 'admin', 'install_freeze', 'read_only', 'recovery'];
const VALID_FAMILIES = [
  'identity',
  'install',
  'memory',
  'procedure',
  'recovery',
  'topic',
  'acl',
  'observation',
  'tag',
  'cohort',
  'feature',
  'broker',
];

/**
 * Load + validate the matrix YAML.
 * @param {string} [path] - path to matrix.yaml
 * @returns {Matrix}
 */
export function loadMatrix(path = DEFAULT_MATRIX_PATH) {
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);
  validate(parsed);
  return new Matrix(parsed);
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('matrix: root must be object');
  if (!parsed.schema_version) throw new Error('matrix: missing schema_version');
  if (!parsed.events || typeof parsed.events !== 'object') throw new Error('matrix: missing events');

  for (const [typeName, row] of Object.entries(parsed.events)) {
    if (typeof row.is_state_bearing !== 'boolean') {
      throw new Error(`matrix[${typeName}]: is_state_bearing must be boolean`);
    }
    if (!VALID_FAMILIES.includes(row.family)) {
      throw new Error(`matrix[${typeName}]: unknown family "${row.family}"`);
    }
    if (!row.admission || typeof row.admission !== 'object') {
      throw new Error(`matrix[${typeName}]: missing admission`);
    }
    for (const mode of BROKER_MODES) {
      const cell = row.admission[mode];
      if (cell !== 'Y' && cell !== 'N') {
        throw new Error(`matrix[${typeName}].admission.${mode}: must be "Y" or "N" (got ${JSON.stringify(cell)})`);
      }
    }
  }
}

/**
 * Matrix: in-memory representation of the Event Capability Matrix.
 *
 * Provides:
 *   - isKnown(type) — whether the type has a row
 *   - isStateBearing(type) — registry-authoritative flag
 *   - family(type) — event family
 *   - isAdmissible(type, socket, mode) — Y/N lookup; the admission oracle
 */
export class Matrix {
  constructor(parsed) {
    this.schemaVersion = parsed.schema_version;
    this.events = parsed.events;
  }

  isKnown(type) {
    return type in this.events;
  }

  isStateBearing(type) {
    const row = this.events[type];
    if (!row) throw new Error(`unknown event type: ${type}`);
    return row.is_state_bearing;
  }

  family(type) {
    const row = this.events[type];
    if (!row) throw new Error(`unknown event type: ${type}`);
    return row.family;
  }

  /**
   * Admission oracle. Matrix columns map to (socket, mode) pairs:
   *   standard        → (standard socket, normal mode)
   *   admin           → (admin socket, normal mode)
   *   install_freeze  → (admin socket, install_freeze mode)
   *   read_only       → (admin socket, read_only mode)
   *   recovery        → (admin socket, recovery mode)
   *
   * Standard socket operates only in normal mode.
   *
   * @param {string} type
   * @param {string} socket - 'standard' | 'admin'
   * @param {string} mode - 'normal' | 'install_freeze' | 'read_only' | 'recovery'
   * @returns {boolean} true if admissible
   */
  isAdmissible(type, socket, mode = 'normal') {
    if (socket !== 'standard' && socket !== 'admin') {
      throw new Error(`invalid socket: ${socket}`);
    }
    if (!['normal', 'install_freeze', 'read_only', 'recovery'].includes(mode)) {
      throw new Error(`invalid mode: ${mode}`);
    }
    const row = this.events[type];
    if (!row) return false; // unknown type: reject (caller handles REGISTER_EVENT_TYPE path)

    // Standard socket: only operates in normal mode.
    if (socket === 'standard') {
      return mode === 'normal' && row.admission.standard === 'Y';
    }

    // Admin socket: pick the column corresponding to the current mode.
    const columnKey = mode === 'normal' ? 'admin' : mode;
    return row.admission[columnKey] === 'Y';
  }

  /**
   * Return all event types (for test coverage + debugging).
   */
  listTypes() {
    return Object.keys(this.events);
  }
}
