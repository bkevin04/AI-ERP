import { z } from "zod";

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** ISO-8601 date (YYYY-MM-DD). */
export const IsoDate = z.iso.date();
/** ISO-8601 timestamp. */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const Address = z.object({
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postalCode: z.string(),
  country: z.string(),
});
export type Address = z.infer<typeof Address>;

export const Currency = z.string().length(3);
