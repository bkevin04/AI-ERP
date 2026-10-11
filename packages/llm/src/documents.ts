import type Anthropic from "@anthropic-ai/sdk";
import type { PreparedDocument } from "@ai-erp/core";

/**
 * Render prepared documents as content blocks. Text documents become labelled text blocks,
 * PDFs become native document blocks so the model reads scanned and digital PDFs alike.
 * The document content always comes last so a stable prompt prefix can be cached.
 */
export function documentsToContent(docs: PreparedDocument[], trailingInstruction: string): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  docs.forEach((d, i) => {
    const label = `Document ${i} (${d.kind}${d.filename ? `, ${d.filename}` : ""}${d.fromAddress ? `, from ${d.fromAddress}` : ""})`;
    if (d.pdfBase64) {
      blocks.push({ type: "text", text: label });
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.pdfBase64 } });
    } else {
      blocks.push({ type: "text", text: `${label}\n<document index="${i}">\n${d.text ?? ""}\n</document>` });
    }
  });
  blocks.push({ type: "text", text: trailingInstruction });
  return blocks;
}
