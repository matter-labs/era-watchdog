import "dotenv/config";
import { ethers, Wallet as EthersWallet } from "ethers";
import express from "express";
import { collectDefaultMetrics, register } from "prom-client";
import winston from "winston";
import { Provider, Wallet as ZkSyncWallet } from "zksync-ethers";

import { DepositFlow } from "./deposit";
import { DepositUserFlow } from "./depositUsers";
import { BlockNumberFlow } from "./getBlockNumber";
import { Mutex } from "./lock";
import { setupLogger } from "./logger";
import { LoggingZkSyncProvider } from "./rpcLoggingProvider";
import { SimpleTxFlow } from "./transfer";
import { SEC, unwrap } from "./utils";
import { WithdrawalFlow } from "./withdrawal";
import { WithdrawalFinalizeFlow } from "./withdrawalFinalize";

const main = async () => {
  setupLogger(process.env.NODE_ENV, process.env.LOG_LEVEL);
  const l2Provider = new LoggingZkSyncProvider(unwrap(process.env.CHAIN_RPC_URL));
  const zkos_mode = process.env.ZKOS_MODE === "1";

  let enabledFlows = 0;

  if (zkos_mode) {
    const wallet = new EthersWallet(unwrap(process.env.WALLET_KEY), l2Provider);
    const l2WalletLock = new Mutex();

    winston.info(
      `Wallet ${wallet.address} L2 balance is ${ethers.formatEther(await l2Provider.getBalance(wallet.address))}`
    );
    if (process.env.FLOW_TRANSFER_ENABLE === "1") {
      new SimpleTxFlow(l2Provider, wallet, l2WalletLock, void 0, +unwrap(process.env.FLOW_TRANSFER_INTERVAL)).run();
      enabledFlows++;
    }

    // Enable block number flow unconditionally in zkos mode
    new BlockNumberFlow(l2Provider, SEC).run();
    enabledFlows++;
  } else {
    const wallet = new ZkSyncWallet(unwrap(process.env.WALLET_KEY), l2Provider);
    const paymasterAddress = process.env.PAYMASTER_ADDRESS;
    const l2WalletLock = new Mutex();

    winston.info(
      `Wallet ${wallet.address} L2 balance is ${ethers.formatEther(await l2Provider.getBalance(wallet.address))}`
    );
    if (process.env.FLOW_TRANSFER_ENABLE === "1") {
      new SimpleTxFlow(
        l2Provider,
        wallet,
        l2WalletLock,
        paymasterAddress,
        +unwrap(process.env.FLOW_TRANSFER_INTERVAL)
      ).run();
      enabledFlows++;
    }

    if (process.env.FLOW_DEPOSIT_ENABLE === "1" || process.env.FLOW_DEPOSIT_USER_ENABLE === "1") {
      const l1Provider = new Provider(unwrap(process.env.CHAIN_L1_RPC_URL));
      const walletDeposit = new ZkSyncWallet(unwrap(process.env.WALLET_KEY), l2Provider, l1Provider);
      const l1BridgeContracts = await walletDeposit.getL1BridgeContracts();
      const chainId = (await walletDeposit.provider.getNetwork()).chainId;
      const baseToken = await walletDeposit.getBaseToken();
      winston.info(
        `Wallet ${walletDeposit.address} L1 balance is ${ethers.formatEther(await l1Provider.getBalance(walletDeposit.address))}`
      );
      if (process.env.FLOW_DEPOSIT_ENABLE === "1") {
        new DepositFlow(
          walletDeposit,
          l1BridgeContracts,
          chainId,
          baseToken,
          +unwrap(process.env.FLOW_DEPOSIT_INTERVAL)
        ).run();
        enabledFlows++;
      }
      if (process.env.FLOW_DEPOSIT_USER_ENABLE === "1") {
        new DepositUserFlow(
          walletDeposit,
          l1BridgeContracts,
          chainId,
          baseToken,
          +unwrap(process.env.FLOW_DEPOSIT_USER_INTERVAL),
          +unwrap(process.env.FLOW_DEPOSIT_USER_TX_TRIGGER_DELAY)
        ).run();
        enabledFlows++;
      }
    }
    if (process.env.FLOW_WITHDRAWAL_ENABLE === "1") {
      new WithdrawalFlow(wallet, paymasterAddress, l2WalletLock, +unwrap(process.env.FLOW_WITHDRAWAL_INTERVAL)).run();
      enabledFlows++;
    }
    if (process.env.FLOW_WITHDRAWAL_FINALIZE_ENABLE === "1") {
      // We need a wallet with both L2 and L1 providers for withdrawal finalization
      // Create a new wallet with L1 provider
      const l1ProviderForWithdrawal = new LoggingZkSyncProvider(unwrap(process.env.CHAIN_L1_RPC_URL));
      const walletForWithdrawals = new ZkSyncWallet(
        unwrap(process.env.WALLET_KEY),
        l2Provider,
        l1ProviderForWithdrawal
      );

      new WithdrawalFinalizeFlow(walletForWithdrawals, +unwrap(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL)).run();
      enabledFlows++;
    }
  }
  winston.info(`Enabled ${enabledFlows} flows`);
  if (enabledFlows === 0) {
    winston.error("No flows enabled");
    process.exit(1);
  }
};

collectDefaultMetrics();

const app = express();

app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

app.listen(+(process.env.METRICS_PORT ?? 8080), "0.0.0.0");

main();
