import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorageAdapter } from '../src/storage/memory_adapter.js';
import { IndexedDBStorageAdapter } from '../src/storage/indexeddb_adapter.js';

describe('Storage Adapters', () => {
  it('MemoryStorageAdapter supports standard key-value and batch operations', async () => {
    const storage = new MemoryStorageAdapter();

    await storage.set('key1', 'value1');
    assert.equal(await storage.get('key1'), 'value1');
    assert.equal(await storage.has('key1'), true);
    assert.equal(await storage.has('nonexistent'), false);

    await storage.setJSON('doc:1', { foo: 'bar', count: 42 });
    const json = await storage.getJSON<{ foo: string; count: number }>('doc:1');
    assert.deepEqual(json, { foo: 'bar', count: 42 });

    await storage.batch([
      { type: 'put', key: 'batch:a', value: '1' },
      { type: 'put', key: 'batch:b', value: '2' },
      { type: 'delete', key: 'key1' },
    ]);

    assert.equal(await storage.get('key1'), null);
    assert.equal(await storage.get('batch:a'), '1');
    assert.equal(await storage.get('batch:b'), '2');

    const batchKeys = await storage.keys('batch:');
    assert.equal(batchKeys.length, 2);

    await storage.clear();
    assert.equal(await storage.has('batch:a'), false);
  });

  it('IndexedDBStorageAdapter provides persistent API with seamless Node/Bun fallback', async () => {
    const idbStorage = new IndexedDBStorageAdapter({ dbName: 'test-db', forceMemoryFallback: true });

    await idbStorage.set('pwa:session', 'active-token');
    assert.equal(await idbStorage.get('pwa:session'), 'active-token');
    assert.equal(await idbStorage.has('pwa:session'), true);

    await idbStorage.setJSON('pwa:state', { offlineDrafts: 3 });
    const state = await idbStorage.getJSON<{ offlineDrafts: number }>('pwa:state');
    assert.equal(state?.offlineDrafts, 3);

    const keys = await idbStorage.keys('pwa:');
    assert.equal(keys.length, 2);

    await idbStorage.delete('pwa:session');
    assert.equal(await idbStorage.get('pwa:session'), null);

    await idbStorage.clear();
    assert.equal(await idbStorage.has('pwa:state'), false);
    await idbStorage.close();
  });
});
