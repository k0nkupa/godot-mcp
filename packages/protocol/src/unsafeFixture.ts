import { z } from "zod";

const UnsafeJobTokenSchema = z.string().regex(/^ujob_[A-Za-z0-9_-]{43}$/);
const EvidenceUriSchema = z.string().regex(/^godot-mcp:\/\/evidence\/[a-f0-9]{64}\/observations\/[0-9a-f-]{36}$/);

export const UnsafeFixtureOperationInputSchema = z.union([
  z.object({ operation: z.literal("execute_start"), source: z.string().min(1).max(65_536).refine((value) => !value.includes("\0"), "Unsafe source may not contain NUL").refine((value) => new TextEncoder().encode(value).byteLength <= 65_536, "Unsafe source exceeds 64 KiB UTF-8"), deadlineMs: z.number().int().min(100).max(10_000).default(10_000) }).strict(),
  z.object({ operation: z.literal("job_status"), jobToken: UnsafeJobTokenSchema }).strict(),
  z.object({ operation: z.literal("job_cancel"), jobToken: UnsafeJobTokenSchema }).strict(),
  z.object({ operation: z.literal("job_result"), jobToken: UnsafeJobTokenSchema }).strict(),
]);

export const UnsafeFixtureJobReceiptSchema = z.object({
  jobToken: UnsafeJobTokenSchema,
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  unsafe: z.literal(true),
  sandboxed: z.literal(false),
  expiresAt: z.string().datetime(),
}).strict();

export const UnsafeFixtureJobResultSchema = UnsafeFixtureJobReceiptSchema.extend({
  state: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBytes: z.number().int().min(1).max(65_536),
  evidence: z.array(EvidenceUriSchema).max(4),
  cleanup: z.enum(["succeeded", "failed"]),
}).strict();

export type UnsafeFixtureOperationInput = z.infer<typeof UnsafeFixtureOperationInputSchema>;
export type UnsafeFixtureJobReceipt = z.infer<typeof UnsafeFixtureJobReceiptSchema>;
export type UnsafeFixtureJobResult = z.infer<typeof UnsafeFixtureJobResultSchema>;
