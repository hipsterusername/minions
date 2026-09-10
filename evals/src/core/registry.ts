export interface VersionedExtension { readonly id: string; readonly version: string; }
export class ExtensionRegistry<T extends VersionedExtension> {
  readonly #items = new Map<string, T>();
  register(item: T): void { const key = `${item.id}@${item.version}`; if (this.#items.has(key)) throw new Error(`extension already registered: ${key}`); this.#items.set(key, item); }
  get(id: string, version: string): T { const item = this.#items.get(`${id}@${version}`); if (!item) throw new Error(`unknown extension: ${id}@${version}`); return item; }
  list(): readonly T[] { return [...this.#items.values()]; }
}
