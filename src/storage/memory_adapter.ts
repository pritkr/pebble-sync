import { StorageAdapter, StorageBatchOp } from './interface.js';

/**
 * In-Memory Storage Adapter
 * Ephemeral memory-backed implementation of StorageAdapter.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async batch(operations: StorageBatchOp[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this.store.set(op.key, op.value);
      } else if (op.type === 'delete') {
        this.store.delete(op.key);
      }
    }
  }

  async close(): Promise<void> {
    // No-op for in-memory
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

  /**
   * Helper to inspect size.
   */
  size(): number {
    return this.store.size;
  }
}
