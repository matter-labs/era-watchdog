import { secp256k1 } from "@noble/curves/secp256k1";
import { createPublicKey } from "crypto";
import { ethers } from "ethers";
import winston from "winston";

import type { KeyManagementServiceClient } from "@google-cloud/kms";
import type { TypedDataDomain, TypedDataField } from "ethers";

/**
 * State shared by a signer and every copy made from it with `connect()`.
 *
 * zksync-ethers calls `wallet._signerL1()` (→ `connect()`) inside most L1
 * helpers, so a single flow iteration can create several signers. Sharing
 * the KMS client and the resolved key keeps that at one gRPC client and one
 * `getPublicKey` call per process instead of one per `connect()`.
 */
interface SharedKmsState {
  client: Promise<KeyManagementServiceClient> | null;
  address: string | null;
  publicKey: string | null;
}

/**
 * An ethers v6 Signer backed by Google Cloud KMS.
 *
 * Expects a KMS key with algorithm EC_SIGN_SECP256K1_SHA256.
 * Uses Application Default Credentials (ADC) — no explicit service-account
 * key is needed when running under Workload Identity on GKE.
 *
 * The WALLET_KEY env var should be the full KMS resource name, e.g.:
 *   projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<version>
 */
export class GcpKmsSigner extends ethers.AbstractSigner {
  private readonly shared: SharedKmsState;

  /**
   * Ethereum address derived from the KMS public key.
   * Available after `getAddress()` has been called at least once
   * (the wallet factory calls it eagerly on creation).
   */
  get address(): string {
    if (!this.shared.address) {
      throw new Error("GcpKmsSigner address not yet resolved — call getAddress() first");
    }
    return this.shared.address;
  }

  /**
   * @param shared Internal: passed by `connect()` so the copy reuses this
   * signer's KMS client and resolved key. Leave unset elsewhere.
   */
  constructor(
    private readonly kmsResourceName: string,
    provider?: ethers.Provider | null,
    shared?: SharedKmsState
  ) {
    super(provider);
    this.shared = shared ?? { client: null, address: null, publicKey: null };
  }

  /**
   * Lazily initialise the KMS client so the `@google-cloud/kms` import
   * is deferred until first use (keeps startup fast when using a hex key).
   * The client is created once and shared with every `connect()` copy.
   */
  private getKmsClient(): Promise<KeyManagementServiceClient> {
    if (!this.shared.client) {
      this.shared.client = (async () => {
        // Dynamic import so the package is only loaded for KMS wallets.
        const { KeyManagementServiceClient } = await import("@google-cloud/kms");
        const client = new KeyManagementServiceClient();
        winston.info(`GCP KMS signer initialised for ${this.kmsResourceName}`);
        return client;
      })().catch((e) => {
        // Don't cache a failed initialisation; let the next call retry.
        this.shared.client = null;
        throw e;
      });
    }
    return this.shared.client;
  }

  // ---- public key / address --------------------------------------------------

  /**
   * Fetches the uncompressed public key from KMS and derives the Ethereum address.
   * The result is cached and shared with every `connect()` copy.
   */
  async getAddress(): Promise<string> {
    if (this.shared.address) return this.shared.address;

    const client = await this.getKmsClient();
    const [publicKeyResponse] = await client.getPublicKey({
      name: this.kmsResourceName,
    });

    if (!publicKeyResponse.pem) {
      throw new Error("GCP KMS returned an empty public key PEM");
    }

    const uncompressedKey = deriveUncompressedPublicKeyFromPem(publicKeyResponse.pem);
    this.shared.publicKey = ethers.hexlify(uncompressedKey);
    this.shared.address = ethers.computeAddress(this.shared.publicKey);
    winston.info(`GCP KMS wallet address: ${this.shared.address}`);
    return this.shared.address;
  }

  // ---- signing ---------------------------------------------------------------

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const unsignedTx =
      tx instanceof ethers.Transaction
        ? ethers.Transaction.from(tx)
        : ethers.Transaction.from((await ethers.resolveProperties(tx)) as ethers.TransactionLike);
    const digest = ethers.keccak256(unsignedTx.unsignedSerialized);
    const sig = await this.kmsSign(digest);
    unsignedTx.signature = sig;
    return unsignedTx.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const digest = ethers.hashMessage(message);
    const sig = await this.kmsSign(digest);
    return ethers.Signature.from(sig).serialized;
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    const sig = await this.kmsSign(digest);
    return ethers.Signature.from(sig).serialized;
  }

  // ---- internal KMS sign + recovery -----------------------------------------

  /**
   * Signs a 32-byte keccak256 digest via GCP KMS and determines the correct
   * recovery parameter (v) by trial.
   */
  private async kmsSign(digest: string): Promise<ethers.SignatureLike> {
    const client = await this.getKmsClient();
    const digestBytes = ethers.getBytes(digest);

    const [signResponse] = await client.asymmetricSign({
      name: this.kmsResourceName,
      digest: { sha256: digestBytes },
    });

    if (!signResponse.signature) {
      throw new Error("GCP KMS returned an empty signature");
    }

    const sigBuffer =
      signResponse.signature instanceof Uint8Array
        ? signResponse.signature
        : new Uint8Array(Buffer.from(signResponse.signature as string, "base64"));

    const sig = secp256k1.Signature.fromDER(sigBuffer).normalizeS();
    const r = sig.r.toString(16).padStart(64, "0");
    const s = sig.s.toString(16).padStart(64, "0");

    // Determine recovery id (v) by trying both 0 and 1.
    const expectedAddress = await this.getAddress();
    for (const v of [27, 28]) {
      const candidate = ethers.recoverAddress(digest, { r: "0x" + r, s: "0x" + s, v });
      if (candidate.toLowerCase() === expectedAddress.toLowerCase()) {
        return { r: "0x" + r, s: "0x" + s, v };
      }
    }

    throw new Error("Failed to determine recovery parameter for KMS signature");
  }

  // ---- helpers ---------------------------------------------------------------

  connect(provider: ethers.Provider): GcpKmsSigner {
    return new GcpKmsSigner(this.kmsResourceName, provider, this.shared);
  }
}

function deriveUncompressedPublicKeyFromPem(pem: string): Uint8Array {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return new Uint8Array([0x04, ...x, ...y]);
}
