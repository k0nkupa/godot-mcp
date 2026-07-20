import { createHash } from "node:crypto";

import type { ProjectOperationInput } from "@godot-mcp/protocol";

import type { ProjectJobService } from "./projectJobService.js";
import type { ProjectMutationService } from "./projectMutationService.js";

export class ProjectService {
  constructor(private readonly mutations: ProjectMutationService, private readonly jobs: ProjectJobService) {}

  async execute(input: ProjectOperationInput, correlationId: string): Promise<{
    data: unknown;
    evidence?: string[];
    audit?: { targetIdentities: unknown[]; preconditions: unknown[]; idempotencyKeySha256: string | null; partialEffects: boolean; rollback: "not_needed" | "succeeded" | "failed" | "not_attempted" };
  }> {
    if (input.operation === "settings_apply" || input.operation === "plugin_set") {
      const result = await this.mutations.execute(input, correlationId);
      return {
        data: result,
        audit: {
          targetIdentities: input.operation === "settings_apply"
            ? result.operation === "settings_apply" ? result.changes.map((change) => change.settingNameSha256) : []
            : result.operation === "plugin_set" ? [result.pluginSha256] : [],
          preconditions: [],
          idempotencyKeySha256: createHash("sha256").update(input.idempotencyKey).digest("hex"),
          partialEffects: false,
          rollback: result.rollback,
        },
      };
    }
    if (input.operation === "import_start" || input.operation === "run_start" || input.operation === "build_start" || input.operation === "export_start") return { data: this.jobs.start(input) };
    if (input.operation === "job_status") return { data: this.jobs.status(input.jobToken) };
    if (input.operation === "job_cancel") return { data: this.jobs.cancel(input.jobToken) };
    const result = this.jobs.result(input.jobToken);
    return { data: result, evidence: result.evidence };
  }
}
