import { z } from "zod";

export const RuntimeHandleSchema = z
  .object({
    runId: z.uuid(),
    generation: z.number().int().min(1),
  })
  .strict();

export const RuntimeLaunchPinsSchema = z
  .object({
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    renderer: z.enum(["gl_compatibility", "mobile"]),
    locale: z.string().regex(/^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    fixedFps: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  })
  .strict();

export type RuntimeHandle = z.infer<typeof RuntimeHandleSchema>;
export type RuntimeLaunchPins = z.infer<typeof RuntimeLaunchPinsSchema>;
