import * as XLSX from "xlsx";
import type { DocumentKind } from "@ai-erp/contracts";
import type { PreparedDocument } from "@ai-erp/core";

export interface StoredDocumentInput {
  id: string;
  kind: DocumentKind;
  filename: string | null;
  fromAddress: string | null;
  mime: string;
  bytes: Uint8Array;
}

/** Turn stored bytes into what the model sees. Text in, PDF as base64, spreadsheets as TSV. */
export function prepareDocument(d: StoredDocumentInput): PreparedDocument {
  const base = { id: d.id, kind: d.kind, filename: d.filename, fromAddress: d.fromAddress };
  switch (d.kind) {
    case "pdf":
      return { ...base, text: null, pdfBase64: Buffer.from(d.bytes).toString("base64") };
    case "xlsx":
    case "csv": {
      const wb = XLSX.read(d.bytes, { type: "buffer" });
      const sheets = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]!;
        const tsv = XLSX.utils.sheet_to_csv(ws, { FS: "\t", blankrows: false });
        return `# sheet: ${name}\n${tsv}`;
      });
      return { ...base, text: sheets.join("\n\n"), pdfBase64: null };
    }
    case "email":
    case "text":
    case "edi":
      return { ...base, text: cleanEmailText(Buffer.from(d.bytes).toString("utf8")), pdfBase64: null };
    case "image":
      return { ...base, text: `[image ${d.filename ?? ""}: not yet supported]`, pdfBase64: null };
  }
}

/** Strip quoted replies and signatures so the model reads the new message, not the thread. */
export function cleanEmailText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^(On .+ wrote:|-----Original Message-----|From: .+|Von: .+|> )/.test(line)) break;
    if (/^--\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function kindFromMime(mime: string, filename: string | null): DocumentKind {
  const m = mime.toLowerCase();
  const f = (filename ?? "").toLowerCase();
  if (m === "application/pdf" || f.endsWith(".pdf")) return "pdf";
  if (m.includes("spreadsheet") || m.includes("excel") || /\.(xlsx|xlsm|xls)$/.test(f)) return "xlsx";
  if (m === "text/csv" || f.endsWith(".csv")) return "csv";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("text/")) return "text";
  return "text";
}
