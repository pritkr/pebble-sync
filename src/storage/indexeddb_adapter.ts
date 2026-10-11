import { StorageAdapter, StorageBatchOp } from './interface.js';

export interface IndexedDBAdapterOptions {
  dbName?: string;
  storeName?: string;
  forceMemoryFallback?: boolean;
}

/**
 * IndexedDB Storage Adapter for Pebble-Sync
 *
 * Provides persistent offline storage for Progressive Web Apps (PWAs), React,
 * Vue, and browser-based edge applications using standard IndexedDB.
 *
 * If running in a non-browser environment (Node.js/Bun) where `window.indexedDB`
 * is unavailable, it gracefully and transparently falls back to an in-memory store
 * to preserve cross-platform runtime portability.
 */
export class IndexedDBStorageAdapter implements StorageAdapter {
  readonly dbName: string;
  readonly storeName: string;
  private db: any = null;
  private isBrowserIndexedDBAvailable = false;
  private memoryFallback = new Map<string, string>();
  private initPromise: Promise<void> | null = null;

  constructor(options?: IndexedDBAdapterOptions) {
    this.dbName = options?.dbName ?? 'pebble_sync_db';
    this.storeName = options?.storeName ?? 'pebble_store';

    const hasIDB =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).indexedDB !== 'undefined';

    this.isBrowserIndexedDBAvailable = hasIDB && !options?.forceMemoryFallback;
  }

  private async getDB(): Promise<any> {
    if (!this.isBrowserIndexedDBAvailable) {
      return null;
    }

    if (this.db) {
      return this.db;
    }

    if (!this.initPromise) {
      this.initPromise = new Promise((resolve, reject) => {
        const idb = (globalThis as any).indexedDB;
        const req = idb.open(this.dbName, 1);

        req.onupgradeneeded = (e: any) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };

        req.onsuccess = (e: any) => {
          this.db = e.target.result;
          resolve();
        };

        req.onerror = (e: any) => {
          // If IndexedDB fails to open, fall back to memory
          this.isBrowserIndexedDBAvailable = false;
          resolve();
        };
      });
    }

    await this.initPromise;
    return this.db;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.getDB();
    if (!db) {
      return this.memoryFallback.get(key) ?? null;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);

        req.onsuccess = () => {
          resolve(req.result !== undefined ? req.result : null);
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        // Fallback on transaction error
        resolve(this.memoryFallback.get(key) ?? null);
      }
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.getDB();
    if (!db) {
      this.memoryFallback.set(key, value);
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(value, key);

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (err) {
        this.memoryFallback.set(key, value);
        resolve();
      }
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDB();
    if (!db) {
      this.memoryFallback.delete(key);
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.delete(key);

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (err) {
        this.memoryFallback.delete(key);
        resolve();
      }
    });
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async keys(prefix?: string): Promise<string[]> {
    const db = await this.getDB();
    if (!db) {
      const all = Array.from(this.memoryFallback.keys());
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAllKeys ? store.getAllKeys() : null;

        if (req) {
          req.onsuccess = () => {
            const list = (req.result as string[]) || [];
            resolve(prefix ? list.filter((k) => String(k).startsWith(prefix)) : list);
          };
          req.onerror = () => reject(req.error);
        } else {
          // Cursor-based iteration
          const collected: string[] = [];
          const cursorReq = store.openKeyCursor();
          cursorReq.onsuccess = (e: any) => {
            const cursor = e.target.result;
            if (cursor) {
              const k = String(cursor.key);
              if (!prefix || k.startsWith(prefix)) {
                collected.push(k);
              }
              cursor.continue();
            } else {
              resolve(collected);
            }
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        }
      } catch (err) {
        const all = Array.from(this.memoryFallback.keys());
        resolve(prefix ? all.filter((k) => k.startsWith(prefix)) : all);
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    if (!db) {
      this.memoryFallback.clear();
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.clear();

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (err) {
        this.memoryFallback.clear();
        resolve();
      }
    });
  }

  async batch(operations: StorageBatchOp[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        await this.set(op.key, op.value);
      } else if (op.type === 'delete') {
        await this.delete(op.key);
      }
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON<T>(key: string, value: T): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }
}
