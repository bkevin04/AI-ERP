import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { cleanEmailText, kindFromMime, prepareDocument } from "../src/index.js";

describe("prepareDocument", () => {
  it("renders spreadsheets as TSV with sheet headers", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["sku", "qty"], ["WID-100", 3]]), "Order");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    const p = prepareDocument({ id: "1", kind: "xlsx", filename: "o.xlsx", fromAddress: null, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes });
    expect(p.text).toContain("# sheet: Order");
    expect(p.text).toContain("WID-100\t3");
  });
  it("passes PDFs as base64 and strips quoted email replies", () => {
    const p = prepareDocument({ id: "1", kind: "pdf", filename: "po.pdf", fromAddress: null, mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
    expect(p.pdfBase64).toBe("JVBERg==");
    expect(cleanEmailText("please send 3 cases\n\nOn Mon, Bob wrote:\n> old stuff")).toBe("please send 3 cases");
  });
  it("infers kinds", () => {
    expect(kindFromMime("application/octet-stream", "order.PDF")).toBe("pdf");
    expect(kindFromMime("text/csv", null)).toBe("csv");
    expect(kindFromMime("image/png", "x.png")).toBe("image");
  });
});
