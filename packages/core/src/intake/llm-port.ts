import type {
  CustomerCandidate,
  DisambiguationResult,
  DocumentKind,
  ExtractedLine,
  ExtractedOrder,
  ProductCandidate,
  TriageResult,
} from "@ai-erp/contracts";

/** A document after preprocessing, ready to be shown to the model. */
export interface PreparedDocument {
  id: string;
  kind: DocumentKind;
  filename: string | null;
  fromAddress: string | null;
  /** Plain text for emails, text files, CSV and spreadsheets (rendered as TSV). */
  text: string | null;
  /** Base64 PDF bytes; passed to the model as a native document block. */
  pdfBase64: string | null;
}

export interface LlmMeta {
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmResult<T> {
  result: T;
  meta: LlmMeta;
}

/**
 * Everything the pipeline needs from a model, behind one interface so tests use fakes
 * and the eval harness can replay stored outputs.
 */
export interface LlmPort {
  triage(docs: PreparedDocument[]): Promise<LlmResult<TriageResult>>;
  extractOrder(docs: PreparedDocument[], opts: { fewShots: string[] }): Promise<LlmResult<ExtractedOrder>>;
  disambiguateProduct(args: { line: ExtractedLine; candidates: ProductCandidate[] }): Promise<LlmResult<DisambiguationResult>>;
  disambiguateCustomer(args: {
    hints: ExtractedOrder["customer"];
    senderEmail: string | null;
    candidates: CustomerCandidate[];
  }): Promise<LlmResult<DisambiguationResult>>;
}
