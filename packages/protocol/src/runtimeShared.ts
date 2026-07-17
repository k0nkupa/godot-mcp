import { z } from "zod";

export const RuntimeHandleSchema = z
  .object({
    runId: z.uuid(),
    generation: z.number().int().min(1),
  })
  .strict();

export type RuntimeHandle = z.infer<typeof RuntimeHandleSchema>;
