/** Stable wire fields are also consumed by native .mjs oracles. */
export class GraderInfrastructureError extends Error {
  readonly kind = 'grader-infrastructure';
  constructor(readonly code: 'GRADER_EXECUTOR' | 'GRADER_PREFLIGHT' | 'GRADER_WATCHDOG', message: string, options?: ErrorOptions) { super(message, options); this.name = 'GraderInfrastructureError'; }
}
export class CandidateLimitError extends Error {
  readonly kind = 'candidate';
  constructor(readonly code: 'CANDIDATE_TIMEOUT' | 'CANDIDATE_OUTPUT_LIMIT', message: string) { super(message); this.name = 'CandidateLimitError'; }
}
export function isCandidateLimit(error: unknown): error is CandidateLimitError {
  const value = error as Partial<CandidateLimitError> | null;
  return value?.kind === 'candidate' && (value.code === 'CANDIDATE_TIMEOUT' || value.code === 'CANDIDATE_OUTPUT_LIMIT');
}
export function infrastructureError(error: unknown): GraderInfrastructureError {
  if ((error as Partial<GraderInfrastructureError> | null)?.kind === 'grader-infrastructure') return error as GraderInfrastructureError;
  return new GraderInfrastructureError('GRADER_EXECUTOR', error instanceof Error ? error.message : String(error), {cause:error});
}
