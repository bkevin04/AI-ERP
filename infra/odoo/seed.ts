/**
 * Seeds the local Odoo with a synthetic distributor (customers, products, price lists)
 * and writes matching purchase-order documents (email text, xlsx, pdf) plus ground truth
 * into infra/odoo/out/ for demos and eval cases.
 *
 *   pnpm odoo:seed            # seed Odoo and generate documents
 *   pnpm odoo:seed --docs-only
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import { OdooClient } from "@ai-erp/connector-odoo";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const docsOnly = process.argv.includes("--docs-only");

// ---- synthetic master data -----------------------------------------------------------
const rnd = mulberry32(42);
const customerNames = [
  "Acme Industrial Supply", "Globex Packaging", "Initech Dental", "Umbrella Salon Supply", "Stark Components", "Wayne Pet Wholesale",
  "Wonka Confectionery Distribution", "Tyrell Electronics", "Cyberdyne Fasteners", "Hooli Office Products", "Vandelay Importers", "Soylent Foods",
  "Dunder Mifflin Paper", "Pied Piper Labs", "Sterling Cooper Supplies", "Oceanic Marine Parts", "Gekko Chemicals", "Bluth Building Supply",
  "Prestige Worldwide Trading", "Massive Dynamic Medical", "Aperture Lab Supplies", "Ollivanders Craft", "Krusty Catering Supply", "Wernham Hogg Stationery",
  "Los Pollos Hermanos Kitchen", "Monarch Solutions", "Nakatomi Trading", "Buy n Large Wholesale", "Octan Industrial", "Gringotts Fixtures",
  "Weyland Fluid Systems", "Virtucon Imports", "Zorg Industries", "Sirius Cybernetics", "Tyrell Automation", "Omni Consumer Products",
  "Rekall Logistics", "Blue Sun Provisions", "Duff Beverage Distribution", "Vehement Capital Supplies", "Ingen Lab Products", "Mom's Friendly Robot Parts",
  "Oscorp Electrical", "Roxxon Energy Supplies", "Stagg Enterprises", "Kord Industries", "Queen Consolidated", "LexCorp Materials", "Wayne Industrial", "Daily Planet Print",
];
const words = ["Widget", "Bracket", "Hex bolt", "Hex nut", "Washer", "Gasket", "Valve", "Coupling", "Hose", "Clamp", "Bearing", "Seal", "Filter", "Gauge", "Switch", "Relay", "Fuse", "Cable", "Connector", "Sensor"];
const specs = ["M5 zinc", "M6 zinc", "M8 stainless", "1/2 inch brass", "3/4 inch brass", "100mm steel", "150mm steel", "200mm aluminium", "10A", "16A", "24V", "230V", "6mm", "8mm", "12mm", "nitrile", "viton", "PTFE", "galvanised", "black oxide"];
const uoms = ["Units", "Units", "Units", "Dozens", "Units"];

interface SeedProduct { sku: string; name: string; description: string; barcode: string; uom: string; price: number; pack: number }
const products: SeedProduct[] = Array.from({ length: 300 }, (_, i) => {
  const w = words[i % words.length]!;
  const s = specs[Math.floor(i / words.length) % specs.length]!;
  return {
    sku: `${w.split(" ")[0]!.toUpperCase().slice(0, 4)}-${String(100 + i)}`,
    name: `${w} ${s}`,
    description: `${w} ${s}, industrial grade`,
    barcode: `40${String(100000000000 + i * 7919).slice(-10)}`,
    uom: uoms[i % uoms.length]!,
    price: Math.round((0.5 + rnd() * 80) * 100) / 100,
    pack: [1, 1, 12, 24, 50][i % 5]!,
  };
});

interface SeedCustomer { name: string; domain: string; email: string; zip: string; city: string; partNos: Record<string, string> }
const customers: SeedCustomer[] = customerNames.map((name, i) => {
  const domain = name.toLowerCase().replace(/[^a-z]+/g, "") + ".example.com";
  const partNos: Record<string, string> = {};
  for (let k = 0; k < 6; k++) { const p = products[(i * 13 + k * 29) % products.length]!; partNos[p.sku] = `${name.slice(0, 3).toUpperCase()}-${1000 + (i * 7 + k)}`; }
  return { name, domain, email: `orders@${domain}`, zip: String(10000 + i * 137), city: ["Springfield", "Riverside", "Fairview", "Greenville", "Bristol"][i % 5]!, partNos };
});

// ---- Odoo seeding --------------------------------------------------------------------------
async function seedOdoo() {
  const client = new OdooClient({ url: process.env["ODOO_URL"] ?? "http://localhost:8069", db: process.env["ODOO_DB"] ?? "odoo", username: process.env["ODOO_USER"] ?? "admin", apiKey: process.env["ODOO_API_KEY"] ?? "admin" });
  await client.login();
  const uomRows = await client.searchRead<{ id: number; name: string }>("uom.uom", [], ["name"]);
  const uomId = (name: string) => uomRows.find((u) => u.name.toLowerCase() === name.toLowerCase())?.id;
  const existingProducts = await client.searchRead<{ id: number; default_code: string | false }>("product.product", [["default_code", "!=", false]], ["default_code"]);
  const have = new Set(existingProducts.map((p) => p.default_code));
  const productIds = new Map<string, number>(existingProducts.filter((p) => p.default_code).map((p) => [String(p.default_code), p.id]));
  for (const p of products) {
    if (have.has(p.sku)) continue;
    const tmplId = await client.create("product.template", { name: p.name, default_code: p.sku, description_sale: p.description, barcode: p.barcode, list_price: p.price, sale_ok: true, purchase_ok: true, detailed_type: "product", uom_id: uomId(p.uom), uom_po_id: uomId(p.uom) });
    const [variant] = await client.searchRead<{ id: number }>("product.product", [["product_tmpl_id", "=", tmplId]], ["id"]);
    if (variant) productIds.set(p.sku, variant.id);
  }
  const existingPartners = await client.searchRead<{ id: number; name: string }>("res.partner", [["is_company", "=", true]], ["name"]);
  const partnerByName = new Map(existingPartners.map((p) => [p.name, p.id]));
  for (const c of customers) {
    if (partnerByName.has(c.name)) continue;
    const id = await client.create("res.partner", { name: c.name, is_company: true, email: c.email, street: `${Math.floor(rnd() * 900) + 1} Industrial Way`, city: c.city, zip: c.zip, customer_rank: 1 });
    await client.create("res.partner", { name: "Purchasing", parent_id: id, email: `buyer@${c.domain}`, type: "contact" });
    partnerByName.set(c.name, id);
  }
  const lists = await client.searchRead<{ id: number; name: string }>("product.pricelist", [], ["name"]);
  let wholesale = lists.find((l) => l.name === "Wholesale")?.id;
  if (!wholesale) {
    wholesale = await client.create("product.pricelist", { name: "Wholesale" });
    for (const p of products.slice(0, 120)) {
      const pid = productIds.get(p.sku);
      if (pid) await client.create("product.pricelist.item", { pricelist_id: wholesale, applied_on: "0_product_variant", product_id: pid, compute_price: "fixed", fixed_price: Math.round(p.price * 0.85 * 100) / 100, min_quantity: 0 });
    }
  }
  // stock on hand so the pipeline sees availability
  const locations = await client.searchRead<{ id: number }>("stock.location", [["usage", "=", "internal"]], ["id"], { limit: 1 });
  if (locations[0]) {
    for (const p of products) {
      const pid = productIds.get(p.sku);
      if (!pid) continue;
      const existing = await client.searchRead<{ id: number }>("stock.quant", [["product_id", "=", pid], ["location_id", "=", locations[0].id]], ["id"], { limit: 1 });
      if (!existing[0]) await client.create("stock.quant", { product_id: pid, location_id: locations[0].id, inventory_quantity: Math.floor(rnd() * 500) });
    }
    const quants = await client.searchRead<{ id: number }>("stock.quant", [["location_id", "=", locations[0].id], ["inventory_quantity_set", "=", true]], ["id"]);
    if (quants.length) await client.executeKw("stock.quant", "action_apply_inventory", [quants.map((q) => q.id)]);
  }
  console.log(`odoo seeded: ${products.length} products, ${customers.length} customers`);
}

// ---- synthetic documents + ground truth -----------------------------------------------------
async function writeDocuments() {
  await mkdir(OUT, { recursive: true });
  const cases: unknown[] = [];
  for (let n = 0; n < 60; n++) {
    const c = customers[n % customers.length]!;
    const lineCount = 1 + Math.floor(rnd() * 5);
    const lines = Array.from({ length: lineCount }, (_, k) => {
      const p = products[(n * 17 + k * 31) % products.length]!;
      const qty = [1, 2, 3, 5, 10, 12, 24, 50, 100][Math.floor(rnd() * 9)]!;
      const useAlias = c.partNos[p.sku] && rnd() < 0.4;
      const uom = p.pack > 1 && rnd() < 0.3 ? "cases" : rnd() < 0.5 ? "ea" : "";
      return { p, qty, sku: useAlias ? c.partNos[p.sku]! : rnd() < 0.15 ? p.sku.toLowerCase().replace("-", " ") : p.sku, uom, price: rnd() < 0.5 ? p.price : null };
    });
    const po = `${c.name.slice(0, 3).toUpperCase()}-PO-${4000 + n}`;
    const date = `2026-10-${String(1 + (n % 28)).padStart(2, "0")}`;
    const kind = (["email", "xlsx", "pdf"] as const)[n % 3]!;
    const base = `case-${String(n).padStart(3, "0")}`;
    const senderEmail = rnd() < 0.8 ? `buyer@${c.domain}` : `${c.name.split(" ")[0]!.toLowerCase()}.purchasing@gmail.com`;
    let filename: string;
    if (kind === "email") {
      filename = `${base}.txt`;
      const body = [`Subject: Purchase order ${po}`, `From: ${senderEmail}`, "", `Hi,`, `Please process the following order for ${c.name} (deliver by ${date}):`, "",
        ...lines.map((l) => `- ${l.qty}${l.uom ? ` ${l.uom}` : ""} x ${l.sku} ${l.p.name}${l.price !== null ? ` @ ${l.price.toFixed(2)}` : ""}`), "", `Ship to our ${c.city} warehouse, ${c.zip}.`, "", "Thanks,", "Purchasing", c.name].join("\n");
      await writeFile(join(OUT, filename), body, "utf8");
    } else if (kind === "xlsx") {
      filename = `${base}.xlsx`;
      const wb = XLSX.utils.book_new();
      const rows = [["PO Number", po], ["Customer", c.name], ["Requested date", date], [], ["Item", "Description", "Qty", "Unit", "Unit price"], ...lines.map((l) => [l.sku, l.p.name, l.qty, l.uom || "ea", l.price ?? ""])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Order");
      await writeFile(join(OUT, filename), new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer));
    } else {
      filename = `${base}.pdf`;
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([595, 842]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      let y = 800;
      const text = (t: string, size = 11) => { page.drawText(t, { x: 50, y, size, font }); y -= size + 6; };
      text(`${c.name}`, 16); text(`PURCHASE ORDER ${po}`, 14); text(`Date: ${date}`); text(`Deliver to: ${c.name}, ${c.city} ${c.zip}`); y -= 10;
      text("Item            Description                       Qty   Unit   Price");
      for (const l of lines) text(`${l.sku.padEnd(16)}${l.p.name.slice(0, 32).padEnd(34)}${String(l.qty).padEnd(6)}${(l.uom || "ea").padEnd(7)}${l.price !== null ? l.price.toFixed(2) : ""}`);
      y -= 10; text("Please confirm receipt. Terms: net 30.");
      await writeFile(join(OUT, filename), await pdf.save());
    }
    cases.push({
      id: base, source: "synthetic", tags: [kind, lineCount > 3 ? "long" : "short"], senderEmail,
      documents: [{ id: base, kind: kind === "email" ? "email" : kind, filename, path: filename, text: null }],
      truth: { customerName: c.name, customerPoNumber: po, requestedDate: date, lines: lines.map((l) => ({ sku: l.p.sku, qty: l.qty, uom: l.uom === "cases" ? "CS" : "EA", unitPrice: l.price })) },
    });
  }
  await writeFile(join(OUT, "cases.json"), JSON.stringify(cases, null, 2));
  await writeFile(join(OUT, "customers.json"), JSON.stringify(customers, null, 2));
  await writeFile(join(OUT, "products.json"), JSON.stringify(products, null, 2));
  console.log(`wrote ${cases.length} synthetic cases to ${OUT}`);
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

if (!docsOnly) await seedOdoo();
await writeDocuments();
