import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditHashChain,
  generatePebbleKeyPair,
  signDelta,
  verifySignedDelta,
  GENESIS_PREV_HASH,
} from '../src/crypto/audit.js';
import { PebbleSyncNode } from '../src/sync/orchestrator.js';
import { DeltaState } from '../src/types.js';

function createDummyDelta(id: string, value: string): DeltaState {
  return {
    deltaId: id,
    nodeId: 'node-audit',
    clock: { 'node-audit': 1 },
    timestamp: { wallTime: 1000, counter: 0, nodeId: 'node-audit' },
    patch: {
      op: 'set_register',
      path: ['patient', 'name'],
      value,
      timestamp: { wallTime: 1000, counter: 0, nodeId: 'node-audit' },
    },
  };
}

describe('Cryptographic Audit Chain & Tamper Detection', () => {
  it('signs deltas with Ed25519 keypair and verifies valid signatures', () => {
    const keyPair = generatePebbleKeyPair();
    const delta = createDummyDelta('delta-1', 'Anita Sharma');

    const signed = signDelta(delta, keyPair, GENESIS_PREV_HASH);
    assert.ok(signed.signature.length > 0);
    assert.equal(signed.previousHash, GENESIS_PREV_HASH);

    const verification = verifySignedDelta(signed);
    assert.equal(verification.valid, true);
  });

  it('detects in-flight tampering of delta payload', () => {
    const keyPair = generatePebbleKeyPair();
    const delta = createDummyDelta('delta-1', 'Anita Sharma');
    const signed = signDelta(delta, keyPair, GENESIS_PREV_HASH);

    // Attacker modifies the payload value without updating signature
    (signed.delta.patch as any).value = 'MALICIOUS_OVERWRITE';

    const verification = verifySignedDelta(signed);
    assert.equal(verification.valid, false);
    assert.ok(verification.reason?.includes('Payload hash mismatch'));
  });

  it('detects forged signatures or wrong author keys', () => {
    const honestKeyPair = generatePebbleKeyPair();
    const attackerKeyPair = generatePebbleKeyPair();
    const delta = createDummyDelta('delta-1', 'Anita Sharma');

    // Attacker signs payload with their key, but claims it belongs to honestKeyPair
    const signedByAttacker = signDelta(delta, attackerKeyPair, GENESIS_PREV_HASH);
    signedByAttacker.authorPublicKey = honestKeyPair.publicKeyHex; // Impersonation attempt

    const verification = verifySignedDelta(signedByAttacker);
    assert.equal(verification.valid, false);
    assert.ok(verification.reason?.includes('Cryptographic Ed25519 signature is invalid'));
  });

  it('maintains tamper-evident audit hash chain and verifies linear history', () => {
    const keyPair = generatePebbleKeyPair();
    const chain = new AuditHashChain();

    for (let i = 0; i < 5; i++) {
      const delta = createDummyDelta(`delta-${i}`, `Value ${i}`);
      const signed = signDelta(delta, keyPair, chain.getLatestHash());
      chain.append(signed, 1000 + i * 10);
    }

    assert.equal(chain.size(), 5);
    const result = chain.verifyChain();
    assert.equal(result.valid, true);
  });

  it('detects tampering within historical audit chain entries', () => {
    const keyPair = generatePebbleKeyPair();
    const chain = new AuditHashChain();

    for (let i = 0; i < 5; i++) {
      const delta = createDummyDelta(`delta-${i}`, `Value ${i}`);
      const signed = signDelta(delta, keyPair, chain.getLatestHash());
      chain.append(signed, 1000 + i * 10);
    }

    const entries = chain.entries();
    // Maliciously tamper with index 2's payload
    (entries[2].signedDelta.delta.patch as any).value = 'TAMPERED_RECORD';

    const tamperedChain = new AuditHashChain(entries);
    const result = tamperedChain.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.corruptedIndex, 2);
  });

  it('detects insertion or broken link in hash chain', () => {
    const keyPair = generatePebbleKeyPair();
    const chain = new AuditHashChain();

    for (let i = 0; i < 4; i++) {
      const delta = createDummyDelta(`delta-${i}`, `Value ${i}`);
      const signed = signDelta(delta, keyPair, chain.getLatestHash());
      chain.append(signed, 1000 + i * 10);
    }

    const entries = chain.entries();
    // Tamper with previousHash pointer at index 3
    entries[3].previousHash = 'f'.repeat(64);

    const tamperedChain = new AuditHashChain(entries);
    const result = tamperedChain.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.corruptedIndex, 3);
    assert.ok(result.error?.includes('Broken hash chain'));
  });

  it('rejects tampered deltas during peer synchronization without corrupting state', async () => {
    const nodeA = new PebbleSyncNode({ nodeId: 'nodeA' });
    const nodeB = new PebbleSyncNode({ nodeId: 'nodeB' });

    // Node A commits an update
    const signedDelta = await nodeA.set('health.vaccinationRate', 95);

    // Intercept and tamper with response sent to Node B
    const offerA = nodeA.createSyncOffer();
    const reqB = nodeB.handleSyncOffer(offerA)!;
    const respA = nodeA.handleSyncRequest(reqB);

    // Attacker modifies the payload
    (respA.signedDeltas[0].delta.patch as any).value = 0; // Maliciously reset vaccination rate to 0

    const syncResult = await nodeB.handleSyncResponse(respA);
    assert.equal(syncResult.valid, false);
    assert.ok(syncResult.error?.includes('Tamper detected'));

    // Verify node B's state was NOT corrupted
    assert.equal(nodeB.get('health.vaccinationRate'), undefined);
  });
});
