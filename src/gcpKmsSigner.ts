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

    // The PEM contains a DER-encoded SubjectPublicKeyInfo.
    // We extract the raw 65-byte uncompressed EC point from it.
    const uncompressedKey = deriveUncompressedPublicKeyFromPem(publicKeyResponse.pem);
    this.cachedPublicKey = ethers.hexlify(uncompressedKey);
    this.cachedAddress = ethers.computeAddress(this.cachedPublicKey);
    winston.info(`GCP KMS wallet address: ${this.cachedAddress}`);
    return this.cachedAddress;
  }

  // ---- signing ---------------------------------------------------------------

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const resolved = await ethers.resolveProperties(tx);
    const unsignedTx = ethers.Transaction.from(resolved as ethers.TransactionLike);
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

    const { r, s } = parseDerSignature(sigBuffer);

    // Normalise s to low-s form (EIP-2).
    const secp256k1N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const halfN = secp256k1N / 2n;
    const sBig = BigInt("0x" + s);
    const sNormalised = sBig > halfN ? (secp256k1N - sBig).toString(16).padStart(64, "0") : s;

    // Determine recovery id (v) by trying both 0 and 1.
    const expectedAddress = await this.getAddress();
    for (const v of [27, 28]) {
      const candidate = ethers.recoverAddress(digest, { r: "0x" + r, s: "0x" + sNormalised, v });
      if (candidate.toLowerCase() === expectedAddress.toLowerCase()) {
        return { r: "0x" + r, s: "0x" + sNormalised, v };
      }
    }

    throw new Error("Failed to determine recovery parameter for KMS signature");
  }

  // ---- helpers ---------------------------------------------------------------

  connect(provider: ethers.Provider): GcpKmsSigner {
    return new GcpKmsSigner(this.kmsResourceName, provider);
  }
}

// =============================================================================
//  Pure helpers
// =============================================================================

/**
 * Extracts the 65-byte uncompressed public key (04 || x || y) from a
 * PEM-encoded SubjectPublicKeyInfo structure returned by GCP KMS.
 */
function deriveUncompressedPublicKeyFromPem(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(base64, "base64");

  // SubjectPublicKeyInfo for secp256k1 has a fixed 23-byte header,
  // followed by the 65-byte uncompressed key (04 || x || y).
  // We look for the 0x04 prefix that starts the uncompressed point.
  const keyStart = der.indexOf(0x04, 20); // skip the ASN.1 header
  if (keyStart === -1 || der.length - keyStart < 65) {
    throw new Error("Cannot extract uncompressed public key from PEM");
  }
  return new Uint8Array(der.buffer, der.byteOffset + keyStart, 65);
}

/**
 * Parses an ASN.1 DER-encoded ECDSA signature into (r, s) hex strings
 * each zero-padded to 64 hex characters.
 */
function parseDerSignature(der: Uint8Array): { r: string; s: string } {
  // SEQUENCE { INTEGER r, INTEGER s }
  if (der[0] !== 0x30) throw new Error("Invalid DER signature: no SEQUENCE tag");

  let offset = 2; // skip SEQUENCE tag + length

  // r
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature: no INTEGER tag for r");
  const rLen = der[offset + 1];
  offset += 2;
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  // s
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature: no INTEGER tag for s");
  const sLen = der[offset + 1];
  offset += 2;
  const sBytes = der.slice(offset, offset + sLen);

  // Strip any leading zero byte (ASN.1 uses it for positive sign)
  const rHex = Buffer.from(rBytes[0] === 0 ? rBytes.slice(1) : rBytes)
    .toString("hex")
    .padStart(64, "0");
  const sHex = Buffer.from(sBytes[0] === 0 ? sBytes.slice(1) : sBytes)
    .toString("hex")
    .padStart(64, "0");

  return { r: rHex, s: sHex };
}
