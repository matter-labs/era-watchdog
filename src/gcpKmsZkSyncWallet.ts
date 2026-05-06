import { Wallet as ZkSyncWallet, EIP712Signer } from "zksync-ethers";
import { EIP712_TX_TYPE, serializeEip712 } from "zksync-ethers/build/utils";

import { GcpKmsSigner } from "./gcpKmsSigner";

import type { ethers, TypedDataDomain, TypedDataField } from "ethers";
import type { Provider } from "zksync-ethers";
import type { TransactionRequest, TransactionResponse } from "zksync-ethers/build/types";

/**
 * A ZkSync Wallet backed by GCP Cloud KMS.
 *
 * Extends the real ZkSyncWallet so every adapter method (deposits, withdrawals,
 * approvals, bridge helpers, …) keeps working.  A throwaway private key is fed
 * to the super-constructor — all actual signing is delegated to `GcpKmsSigner`.
 */
export class GcpKmsZkSyncWallet extends ZkSyncWallet {
  private readonly kmsSigner: GcpKmsSigner;
  private kmsAddress: string | null = null;

  /**
   * Use `GcpKmsZkSyncWallet.create()` instead of calling this directly.
   */
  private constructor(
    kmsSigner: GcpKmsSigner,
    kmsAddress: string,
    providerL2?: Provider,
    providerL1?: ethers.Provider
  ) {
    // A dummy key is required by the base class constructor.
    // We immediately override the address and all signing paths.
    const dummyKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
    super(dummyKey, providerL2, providerL1);

    this.kmsSigner = kmsSigner;
    this.kmsAddress = kmsAddress;

    // Override the `address` property that ethers.BaseWallet sets as a
    // non-writable own property.  It is configurable, so defineProperty works.
    Object.defineProperty(this, "address", {
      value: kmsAddress,
      writable: false,
      enumerable: true,
      configurable: true,
    });

    // Re-create the EIP-712 signer so it delegates signTypedData to *this*
    // (which we override below) rather than the dummy base wallet.
    if (this.provider) {
      const network = this.provider.getNetwork();
      this.eip712 = new EIP712Signer(
        this as unknown as ethers.Signer,
        network.then((n) => Number(n.chainId))
      );
    }
  }

  /**
   * Async factory — resolves the KMS address before construction.
   */
  static async create(
    kmsResourceName: string,
    providerL2?: Provider,
    providerL1?: ethers.Provider
  ): Promise<GcpKmsZkSyncWallet> {
    const kmsSigner = new GcpKmsSigner(kmsResourceName, providerL2 ?? null);
    const kmsAddress = await kmsSigner.getAddress();
    return new GcpKmsZkSyncWallet(kmsSigner, kmsAddress, providerL2, providerL1);
  }

  // ---- signing overrides ----------------------------------------------------

  override async signTransaction(tx: TransactionRequest): Promise<string> {
    const populated = await this.populateTransaction(tx);
    if (populated.type !== EIP712_TX_TYPE) {
      // Standard (non-EIP712) transaction — delegate to KMS signer directly.
      return await this.kmsSigner.signTransaction(populated as ethers.TransactionRequest);
    }
    // EIP-712 ZkSync transaction
    populated.customData!.customSignature = await this.eip712.sign(populated);
    return serializeEip712(populated);
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    return (await this.provider.broadcastTransaction(await this.signTransaction(tx))) as TransactionResponse;
  }

  override async signMessage(message: string | Uint8Array): Promise<string> {
    return await this.kmsSigner.signMessage(message);
  }

  override async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    return await this.kmsSigner.signTypedData(domain, types, value);
  }

  // ---- L1 signer override ---------------------------------------------------

  /** Returns an ethers-level KMS signer connected to the L1 provider. */
  override _signerL1(): ethers.Wallet {
    // The adapter typings say `ethers.Wallet`, but the only methods actually
    // called on _signerL1() are Signer methods (getNonce, sendTransaction,
    // getAddress, etc.).  We return our KMS signer cast through `as any`
    // because it satisfies the runtime contract even though the static type
    // is narrower.
    return this.kmsSigner.connect(this._providerL1()) as unknown as ethers.Wallet;
  }

  override _signerL2(): GcpKmsZkSyncWallet {
    return this;
  }

  /** Override to avoid constructing a new ethers.Wallet with the dummy signingKey. */
  override ethWallet(): ethers.Wallet {
    return this.kmsSigner.connect(this._providerL1()) as unknown as ethers.Wallet;
  }

  // ---- getAddress override --------------------------------------------------

  override async getAddress(): Promise<string> {
    return this.kmsAddress!;
  }
}
