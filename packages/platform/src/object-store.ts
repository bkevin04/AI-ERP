import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

export class MemoryObjectStore implements ObjectStore {
  private readonly items = new Map<string, { bytes: Uint8Array; mime: string }>();
  async put(key: string, bytes: Uint8Array, mime: string) { this.items.set(key, { bytes, mime }); }
  async get(key: string) { return this.items.get(key) ?? null; }
}

/** Local-disk store for development. S3/MinIO replaces it with the same interface. */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}
  private path(key: string) {
    if (key.includes("..")) throw new Error("invalid key");
    return join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(`${p}.mime`, mime);
  }
  async get(key: string) {
    try {
      const p = this.path(key);
      return { bytes: new Uint8Array(await readFile(p)), mime: await readFile(`${p}.mime`, "utf8") };
    } catch {
      return null;
    }
  }
}
