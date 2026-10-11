import { z } from "zod";
import { Address, Currency, IsoDate } from "./primitives.js";

/** Canonical shapes every ERP connector maps to and from. */

export const ExtContact = z.object({
  externalId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});

export const ExtCustomer = z.object({
  externalId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  emailDomains: z.array(z.string()),
  billingAddress: Address.nullable(),
  shipTo: z.array(Address),
  contacts: z.array(ExtContact),
  paymentTerms: z.string().nullable(),
  active: z.boolean(),
});
export type ExtCustomer = z.infer<typeof ExtCustomer>;

export const ExtProduct = z.object({
  externalId: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  barcode: z.string().nullable(),
  uom: z.string(),
  listPrice: z.number().nullable(),
  active: z.boolean(),
});
export type ExtProduct = z.infer<typeof ExtProduct>;

export const ExtPriceListItem = z.object({
  productExternalId: z.string(),
  minQty: z.number().nonnegative(),
  unitPrice: z.number(),
  uom: z.string().nullable(),
});

export const ExtPriceList = z.object({
  externalId: z.string(),
  name: z.string(),
  currency: Currency,
  items: z.array(ExtPriceListItem),
});
export type ExtPriceList = z.infer<typeof ExtPriceList>;

export const ExtStock = z.object({
  productExternalId: z.string(),
  location: z.string(),
  qtyAvailable: z.number(),
  asOf: z.date(),
});
export type ExtStock = z.infer<typeof ExtStock>;

export const CanonicalOrderLine = z.object({
  productExternalId: z.string(),
  description: z.string(),
  qty: z.number(),
  uom: z.string().nullable(),
  unitPrice: z.number().nullable(),
});

export const CanonicalOrder = z.object({
  /** Our order number; stored as the ERP's client reference for idempotent push. */
  orderNumber: z.string(),
  customerExternalId: z.string(),
  customerPoNumber: z.string().nullable(),
  requestedDate: IsoDate.nullable(),
  currency: Currency,
  shipTo: Address.nullable(),
  lines: z.array(CanonicalOrderLine),
});
export type CanonicalOrder = z.infer<typeof CanonicalOrder>;

export const ExtOrderRef = z.object({
  externalId: z.string(),
  externalNumber: z.string().nullable(),
});
export type ExtOrderRef = z.infer<typeof ExtOrderRef>;

export const ExtOrderStatus = z.object({
  externalId: z.string(),
  state: z.enum(["draft", "confirmed", "done", "cancelled", "unknown"]),
  raw: z.record(z.string(), z.unknown()),
});
export type ExtOrderStatus = z.infer<typeof ExtOrderStatus>;

export const ConnectorKind = z.enum(["odoo", "business_central", "netsuite", "quickbooks", "dryrun"]);
export type ConnectorKind = z.infer<typeof ConnectorKind>;
