import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtractedOrder, TriageResult } from "@ai-erp/contracts";
import { documentsToContent } from "../src/documents.js";

describe("documentsToContent", () => {
  it("renders text documents inline and PDFs as native document blocks, instruction last", () => {
    const blocks = documentsToContent(
      [
        { id: "1", kind: "email", filename: null, fromAddress: "a@b.com", text: "hello", pdfBase64: null },
        { id: "2", kind: "pdf", filename: "po.pdf", fromAddress: null, text: null, pdfBase64: "QUJD" },
      ],
      "Extract.",
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { text: string }).text).toContain('<document index="0">');
    expect(blocks[2]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
    expect(blocks[3]).toEqual({ type: "text", text: "Extract." });
  });
});

describe("LLM-facing schemas", () => {
  it("compile to strict JSON schemas with no optional fields", () => {
    for (const schema of [ExtractedOrder, TriageResult]) {
      const json = z.toJSONSchema(schema) as { required?: string[]; properties: Record<string, unknown>; additionalProperties?: boolean };
      expect(json.required?.length).toBe(Object.keys(json.properties).length);
      expect(json.additionalProperties).toBe(false);
    }
  });
});
