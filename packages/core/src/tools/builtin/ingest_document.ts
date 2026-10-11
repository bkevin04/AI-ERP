import { z } from "zod";
import { DocumentKind } from "@ai-erp/contracts";
import { newId } from "../../util.js";
import { defineTool } from "../define.js";

export const ingestDocument = defineTool({
  name: "ingest_document",
  description: "Register a stored document (email, PDF, spreadsheet) and emit a document.received event. Deduplicates by content hash and provider message id.",
  scope: "documents:write",
  sideEffects: "write",
  exposure: ["http", "agent", "mcp"],
  idempotency: "optional",
  input: z.object({
    kind: DocumentKind,
    storageKey: z.string(),
    sha256: z.string().length(64),
    mime: z.string(),
    filename: z.string().nullable().default(null),
    parentDocumentId: z.uuid().nullable().default(null),
    fromAddress: z.string().nullable().default(null),
    providerMessageId: z.string().nullable().default(null),
    textKey: z.string().nullable().default(null),
    pageCount: z.number().int().nullable().default(null),
  }),
  output: z.object({
    documentId: z.uuid(),
    created: z.boolean(),
    eventId: z.uuid(),
    eventCreated: z.boolean(),
  }),
  handler: async (ctx, input) => {
    const doc = await ctx.store.insertDocument({ id: newId(), ...input });
    const event = await ctx.store.insertEvent({
      id: newId(),
      type: "document.received",
      payload: { documentId: doc.id, kind: input.kind, fromAddress: input.fromAddress, parentDocumentId: input.parentDocumentId },
      idempotencyKey: input.providerMessageId ? `document.received:msg:${input.providerMessageId}:${input.sha256}` : `document.received:${input.sha256}`,
    });
    if (doc.created) {
      ctx.recordChange({
        entityType: "document",
        entityId: doc.id,
        entityVersion: 1,
        action: "document.received",
        proposalId: null,
        approvalId: null,
        policyVersion: null,
        promptVersion: null,
        modelId: null,
        sourceDocumentIds: [doc.id],
        diff: { kind: input.kind, sha256: input.sha256, filename: input.filename },
      });
    }
    return { documentId: doc.id, created: doc.created, eventId: event.id, eventCreated: event.created };
  },
});
