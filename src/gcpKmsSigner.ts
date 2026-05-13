import { secp256k1 } from "@noble/curves/secp256k1";
import { createPublicKey } from "crypto";
import { ethers } from "ethers";
import winston from "winston";

import type { KeyManagementServiceClient } from "@google-cloud/kms";
import type { TypedDataDomain, TypedDataField } from "ethers";

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
  private kmsClient!: KeyManagementServiceClient;
  private cachedAddress: string | null = null;
  private cachedPublicKey: string | null = null;

  /**
   * Ethereum address derived from the KMS public key.
   * Available after `getAddress()` has been called at least once
   * (the wallet factory calls it eagerly on creation).
   */
  get address(): string {
    if (!this.cachedAddress) {
      throw new Error("GcpKmsSigner address not yet resolved — call getAddress() first");
    }
    return this.cachedAddress;
  }

  constructor(
    private readonly kmsResourceName: string,
    provider?: ethers.Provider | null
  ) {
    super(provider);
  }

  /**
   * Lazily initialise the KMS client so the `@google-cloud/kms` import
   * is deferred until first use (keeps startup fast when using a hex key).
   */
  private async getKmsClient(): Promise<KeyManagementServiceClient> {
    if (!this.kmsClient) {
      // Dynamic import so the package is only loaded for KMS wallets.
      const { KeyManagementServiceClient } = await import("@google-cloud/kms");
      this.kmsClient = new KeyManagementServiceClient();
      winston.info(`GCP KMS signer initialised for ${this.kmsResourceName}`);
    }
    return this.kmsClient;
  }

  // ---- public key / address --------------------------------------------------

  /**
   * Fetches the uncompressed public key from KMS and derives the Ethereum address.
   * The result is cached for the lifetime of this signer.
   */
  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;

    const client = await this.getKmsClient();
    const [publicKeyResponse] = await client.getPublicKey({
      name: this.kmsResourceName,
    });

    if (!publicKeyResponse.pem) {
      throw new Error("GCP KMS returned an empty public key PEM");
    }

    const uncompressedKey = deriveUncompressedPublicKeyFromPem(publicKeyResponse.pem);
    this.cachedPublicKey = ethers.hexlify(uncompressedKey);
    this.cachedAddress = ethers.computeAddress(this.cachedPublicKey);
    winston.info(`GCP KMS wallet address: ${this.cachedAddress}`);
    return this.cachedAddress;
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
    return new GcpKmsSigner(this.kmsResourceName, provider);
  }
}

function deriveUncompressedPublicKeyFromPem(pem: string): Uint8Array {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return new Uint8Array([0x04, ...x, ...y]);
}
