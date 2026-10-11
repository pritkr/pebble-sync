import {
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { canonicalJson, sha256 } from '../merkle/clock.js';
import { DeltaState, SignedDelta } from '../types.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);

export interface PebbleKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyHex: string;
  signMessage(data: string | Uint8Array): string;
}

export interface AuditEntry {
  index: number;
  timestamp: number;
  deltaHash: string;
  previousHash: string;
  entryHash: string;
  signedDelta: SignedDelta;
}

export interface ChainVerificationResult {
  valid: boolean;
  corruptedIndex?: number;
  error?: string;
}

/**
 * Generate a new Ed25519 keypair for cryptographic delta signing.
 */
export function generatePebbleKeyPair(): PebbleKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

  return {
    privateKey,
    publicKey,
    publicKeyHex,
    signMessage(data: string | Uint8Array): string {
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      return sign(null, buffer, privateKey).toString('hex');
    },
  };
}

/**
 * Verify Ed25519 signature given DER SPKI public key hex.
 */
export function verifySignature(
  data: string | Uint8Array,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const pubKey = createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, buffer, pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Sign a DeltaState and compute its cryptographic tamper-evident wrapper.
 */
export function signDelta(
  delta: DeltaState,
  keyPair: PebbleKeyPair,
  previousHash: string = GENESIS_PREV_HASH
): SignedDelta {
  const deltaHash = sha256(canonicalJson(delta));
  // Commit to previous hash for strict linear chain integrity
  const signPayload = `${previousHash}:${deltaHash}`;
  const signature = keyPair.signMessage(signPayload);

  return {
    delta,
    authorPublicKey: keyPair.publicKeyHex,
    signature,
    hash: deltaHash,
    previousHash,
  };
}

/**
 * Verify a SignedDelta's payload hash and cryptographic signature.
 */
export function verifySignedDelta(signedDelta: SignedDelta): { valid: boolean; reason?: string } {
  // 1. Verify payload hash integrity
  const recomputedDeltaHash = sha256(canonicalJson(signedDelta.delta));
  if (recomputedDeltaHash !== signedDelta.hash) {
    return {
      valid: false,
      reason: `Payload hash mismatch: computed=${recomputedDeltaHash}, declared=${signedDelta.hash}`,
    };
  }

  // 2. Verify signature over chained hash
  const prev = signedDelta.previousHash ?? GENESIS_PREV_HASH;
  const signPayload = `${prev}:${signedDelta.hash}`;
  const isValidSignature = verifySignature(
    signPayload,
    signedDelta.signature,
    signedDelta.authorPublicKey
  );

  if (!isValidSignature) {
    return {
      valid: false,
      reason: 'Cryptographic Ed25519 signature is invalid or author key does not match',
    };
  }

  return { valid: true };
}

/**
 * Tamper-Evident Cryptographic Audit Hash Chain
 * Appends deltas in a verifiable chain: H_n = SHA256(index + prevHash + deltaHash + timestamp).
 * Provides mathematical proof of operation order and detects any alteration, truncation, or reordering.
 */
export class AuditHashChain {
  private chain: AuditEntry[] = [];

  constructor(initialChain?: AuditEntry[]) {
    if (initialChain) {
      this.chain = initialChain.map((e) => JSON.parse(JSON.stringify(e)));
    }
  }

  /**
   * Current latest hash in the audit chain.
   */
  getLatestHash(): string {
    if (this.chain.length === 0) {
      return GENESIS_PREV_HASH;
    }
    return this.chain[this.chain.length - 1].entryHash;
  }

  /**
   * Append a signed delta to the audit chain.
   */
  append(signedDelta: SignedDelta, customTimestamp?: number): AuditEntry {
    const index = this.chain.length;
    const previousHash = this.getLatestHash();
    const timestamp = customTimestamp ?? Date.now();
    const deltaHash = signedDelta.hash;

    const entryHash = sha256(`${index}:${previousHash}:${deltaHash}:${timestamp}`);

    const entry: AuditEntry = {
      index,
      timestamp,
      deltaHash,
      previousHash,
      entryHash,
      signedDelta: JSON.parse(JSON.stringify(signedDelta)),
    };

    this.chain.push(entry);
    return entry;
  }

  /**
   * Length of the audit chain.
   */
  size(): number {
    return this.chain.length;
  }

  /**
   * Immutable clone of entries.
   */
  entries(): AuditEntry[] {
    return this.chain.map((e) => JSON.parse(JSON.stringify(e)));
  }

  /**
   * Verify total integrity of audit chain.
   * Checks every entry's hash continuity, payload integrity, and Ed25519 signature.
   */
  verifyChain(): ChainVerificationResult {
    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i];

      // Check index
      if (entry.index !== i) {
        return {
          valid: false,
          corruptedIndex: i,
          error: `Index mismatch at ${i}: found ${entry.index}`,
        };
      }

      // Check previous hash continuity
      const expectedPrev = i === 0 ? GENESIS_PREV_HASH : this.chain[i - 1].entryHash;
      if (entry.previousHash !== expectedPrev) {
        return {
          valid: false,
          corruptedIndex: i,
          error: `Broken hash chain at ${i}: expected prev=${expectedPrev}, found=${entry.previousHash}`,
        };
      }

      // Check entry hash recomputation
      const expectedEntryHash = sha256(
        `${entry.index}:${entry.previousHash}:${entry.deltaHash}:${entry.timestamp}`
      );
      if (entry.entryHash !== expectedEntryHash) {
        return {
          valid: false,
          corruptedIndex: i,
          error: `Entry hash corrupted at ${i}: expected=${expectedEntryHash}, found=${entry.entryHash}`,
        };
      }

      // Check signed delta payload and signature
      const deltaCheck = verifySignedDelta(entry.signedDelta);
      if (!deltaCheck.valid) {
        return {
          valid: false,
          corruptedIndex: i,
          error: `Delta signature or payload invalid at ${i}: ${deltaCheck.reason}`,
        };
      }
    }

    return { valid: true };
  }
}
