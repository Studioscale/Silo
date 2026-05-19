/**
 * AdmissionError — structured rejection from the M3 matrix admission gate.
 *
 * Distinct from `AdmissionValidationError` (payload shape/content) per spec
 * §3.3: capability/type errors land here; payload-malformed errors stay on
 * the existing validator. Callers pattern-match on `.code`.
 *
 * Codes:
 *   UNKNOWN_EVENT_TYPE_NOT_REGISTERED — type not in matrix.yaml
 *   EVENT_NOT_ADMISSIBLE              — type known but isAdmissible returned false
 *   INVALID_WRITER_MODE               — caller passed mode != 'normal'
 */

export class AdmissionError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = 'AdmissionError';
    this.code = code;
    this.details = details;
  }
}
