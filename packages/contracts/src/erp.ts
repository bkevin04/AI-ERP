import { z } from "zod";
import { Address, Currency, IsoDate, Uuid } from "./primitives.js";

export const Customer = z.object({
  id: Uuid,
  tenantId: Uuid,
  name: z.string(),
  normalizedName: z.string(),
  emailDomains: z.array(z.string()),
  billingAddress: Address.nullable(),
  shipTo: z.array(Address),
  defaultPriceListId: Uuid.nullable(),
  paymentTerms: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
});
export type Customer = z.infer<typeof Customer>;

export const CustomerContact = z.object({
  id: Uuid,
  tenantId: Uuid,
  customerId: Uuid,
  email: z.string(),
  name: z.string().nullable(),
});
export type CustomerContact = z.infer<typeof CustomerContact>;

export const Product = z.object({
  id: Uuid,
  tenantId: Uuid,
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  baseUom: z.string(),
  barcode: z.string().nullable(),
  /** uom code -> how many base units one of that uom contains, e.g. { CS: 12 } */
  packFactors: z.record(z.string(), z.number().positive()),
  listPrice: z.number().nullable(),
  status: z.enum(["active", "inactive"]),
});
export type Product = z.infer<typeof Product>;

export const AliasType = z.enum(["customer_part_no", "description", "synonym"]);
export const AliasSource = z.enum(["correction", "import", "inferred"]);

export const ProductAlias = z.object({
  id: Uuid,
  tenantId: Uuid,
  productId: Uuid,
  customerId: Uuid.nullable(),
  aliasType: AliasType,
  aliasNorm: z.string(),
  uomOverride: z.string().nullable(),
  source: AliasSource,
});
export type ProductAlias = z.infer<typeof ProductAlias>;

export const PriceList = z.object({
  id: Uuid,
  tenantId: Uuid,
  name: z.string(),
  currency: Currency,
  validFrom: IsoDate.nullable(),
  validTo: IsoDate.nullable(),
});
export type PriceList = z.infer<typeof PriceList>;

export const PriceListItem = z.object({
  priceListId: Uuid,
  productId: Uuid,
  minQty: z.number().nonnegative(),
  unitPrice: z.number(),
  uom: z.string().nullable(),
});
export type PriceListItem = z.infer<typeof PriceListItem>;

export const StockSnapshot = z.object({
  tenantId: Uuid,
  productId: Uuid,
  location: z.string(),
  qtyAvailable: z.number(),
  asOf: z.date(),
});
export type StockSnapshot = z.infer<typeof StockSnapshot>;

export const DocumentKind = z.enum(["email", "pdf", "xlsx", "csv", "image", "text", "edi"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const Document = z.object({
  id: Uuid,
  tenantId: Uuid,
  kind: DocumentKind,
  storageKey: z.string(),
  sha256: z.string(),
  mime: z.string(),
  filename: z.string().nullable(),
  parentDocumentId: Uuid.nullable(),
  fromAddress: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  textKey: z.string().nullable(),
  pageCount: z.number().int().nullable(),
});
export type Document = z.infer<typeof Document>;

export const OrderStatus = z.enum([
  "draft",
  "pending_review",
  "approved",
  "committed",
  "written_back",
  "rejected",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderLine = z.object({
  id: Uuid,
  orderId: Uuid,
  lineNo: z.number().int(),
  productId: Uuid.nullable(),
  description: z.string(),
  qty: z.number(),
  uom: z.string(),
  unitPrice: z.number().nullable(),
  lineTotal: z.number().nullable(),
  matchMethod: z.string().nullable(),
  matchConfidence: z.number().nullable(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
});
export type OrderLine = z.infer<typeof OrderLine>;

export const Order = z.object({
  id: Uuid,
  tenantId: Uuid,
  number: z.string(),
  customerId: Uuid,
  status: OrderStatus,
  customerPoNumber: z.string().nullable(),
  currency: Currency,
  requestedDate: IsoDate.nullable(),
  shipTo: Address.nullable(),
  totals: z.object({ subtotal: z.number(), lineCount: z.number().int() }),
  createdFromProposalId: Uuid.nullable(),
  version: z.number().int(),
});
export type Order = z.infer<typeof Order>;
