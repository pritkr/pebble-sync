/**
 * Storage Adapter Interface for Pebble-Sync
 * Pluggable offline storage abstraction compatible with In-Memory, IndexedDB, LevelDB, and Filesystem.
 */

export type StorageBatchOp =
  | { type: 'put'; key: string; value: string }
  | { type: 'delete'; key: string };

export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  batch(operations: StorageBatchOp[]): Promise<void>;
  close(): Promise<void>;

  // Convenience JSON helpers
  getJSON<T>(key: string): Promise<T | null>;
  setJSON<T>(key: string, value: T): Promise<void>;
}
