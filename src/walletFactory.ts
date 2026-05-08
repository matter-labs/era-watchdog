import { Wallet as EthersWallet } from "ethers";
import winston from "winston";
import { Wallet as ZkSyncWallet } from "zksync-ethers";

import { GcpKmsSigner } from "./gcpKmsSigner";
import { GcpKmsZkSyncWallet } from "./gcpKmsZkSyncWallet";

import type { ethers } from "ethers";
import type { Provider } from "zksync-ethers";

/**
 * Returns `true` when `walletKey` looks like a GCP KMS resource name
 * (e.g. "projects/my-proj/locations/global/keyRings/…/cryptoKeyVersions/1").
 */
export function isKmsKey(walletKey: string): boolean {
  return walletKey.startsWith("projects/");
}

// ---- Ethers-level signer (for Prividium / ZKOS simple transfers) ------------

/**
 * Creates an ethers `Signer` from the wallet key.
 *
 * - Hex key  → `ethers.Wallet`
 * - KMS name → `GcpKmsSigner`
 */
export async function createEthersSigner(
  walletKey: string,
  provider?: ethers.Provider | null
): Promise<EthersWallet | GcpKmsSigner> {
  if (isKmsKey(walletKey)) {
    winston.info("Creating GCP KMS ethers signer");
    const signer = new GcpKmsSigner(walletKey, provider);
    await signer.getAddress(); // eagerly resolve & cache the address
    return signer;
  }
  return new EthersWallet(walletKey, provider);
}

// ---- ZkSync-level wallet (for deposits, withdrawals, full flows) ------------

/**
 * Creates a ZkSync `Wallet` from the wallet key.
 *
 * - Hex key  → `ZkSyncWallet`
 * - KMS name → `GcpKmsZkSyncWallet` (async factory)
 */
export async function createZkSyncWallet(
  walletKey: string,
  providerL2?: Provider,
  providerL1?: ethers.Provider
): Promise<ZkSyncWallet> {
  if (isKmsKey(walletKey)) {
    winston.info("Creating GCP KMS ZkSync wallet");
    return await GcpKmsZkSyncWallet.create(walletKey, providerL2, providerL1);
  }
  return new ZkSyncWallet(walletKey, providerL2, providerL1);
}
