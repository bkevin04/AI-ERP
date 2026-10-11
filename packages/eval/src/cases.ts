import { z } from "zod";
import { GroundTruthOrder } from "./score.js";

/** On-disk eval case: the documents to feed the pipeline plus what the human finally approved. */
export const EvalCaseFile = z.object({
  id: z.string(),
  source: z.enum(["historical", "from_approval", "synthetic"]),
  tags: z.array(z.string()).default([]),
  senderEmail: z.string().nullable(),
  documents: z.array(z.object({
    id: z.string(),
    kind: z.enum(["email", "pdf", "xlsx", "csv", "image", "text", "edi"]),
    filename: z.string().nullable(),
    /** Path relative to the case file for binary documents, or inline text. */
    path: z.string().nullable(),
    text: z.string().nullable(),
  })),
  truth: GroundTruthOrder,
});
export type EvalCaseFile = z.infer<typeof EvalCaseFile>;
