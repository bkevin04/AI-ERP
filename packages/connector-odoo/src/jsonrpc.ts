export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  /** API key (Odoo 14+) or password. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OdooRpcError extends Error {
  constructor(message: string, public readonly data: unknown) {
    super(message);
    this.name = "OdooRpcError";
  }
}

/** Minimal JSON-RPC client for Odoo's /jsonrpc endpoint (common.login + object.execute_kw). */
export class OdooClient {
  private uid: number | null = null;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OdooConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.url.replace(/\/$/, "")}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "call", params: { service, method, args } }),
    });
    if (!res.ok) throw new OdooRpcError(`odoo http ${res.status}`, await res.text().catch(() => null));
    const body = (await res.json()) as { result?: T; error?: { message?: string; data?: { message?: string; debug?: string } } };
    if (body.error) throw new OdooRpcError(body.error.data?.message ?? body.error.message ?? "odoo rpc error", body.error);
    return body.result as T;
  }

  async login(): Promise<number> {
    if (this.uid !== null) return this.uid;
    const uid = await this.call<number | false>("common", "login", [this.cfg.db, this.cfg.username, this.cfg.apiKey]);
    if (!uid) throw new OdooRpcError("odoo login failed", null);
    this.uid = uid;
    return uid;
  }

  async executeKw<T>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const uid = await this.login();
    return this.call<T>("object", "execute_kw", [this.cfg.db, uid, this.cfg.apiKey, model, method, args, kwargs]);
  }

  searchRead<T>(model: string, domain: unknown[], fields: string[], extra: Record<string, unknown> = {}): Promise<T[]> {
    return this.executeKw<T[]>(model, "search_read", [domain], { fields, ...extra });
  }

  create(model: string, values: Record<string, unknown>): Promise<number> {
    return this.executeKw<number>(model, "create", [values]);
  }
}
