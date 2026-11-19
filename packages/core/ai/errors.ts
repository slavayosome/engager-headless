/**
 * Model-output failures, in their own leaf module so an LLM implementation can
 * throw the canonical error without importing `ai/client` at runtime — which
 * would close an import cycle (client picks the backend, the backend needs the
 * error). Re-exported from `ai/client` so every existing importer is unchanged.
 */
export class LLMOutputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMOutputError";
  }
}

/** A required grounded call cannot degrade to an ungrounded local answer. */
export class GroundingEvidenceRequiredError extends LLMOutputError {
  constructor() { super("grounding_evidence_required"); this.name = "GroundingEvidenceRequiredError"; }
}
