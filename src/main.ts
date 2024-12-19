import "dotenv/config";
import { ethers } from "ethers";
import express from "express";
import { collectDefaultMetrics, register } from "prom-client";
import winston from "winston";
import { Provider, Wallet } from "zksync-ethers";

import { setupLogger } from "./logger";
import { SimpleTxFlow } from "./transfer";
import { MIN, unwrap } from "./utils";

const main = async () => {
  setupLogger(process.env.NODE_ENV, process.env.LOG_LEVEL);
  const l2Provider = new Provider(unwrap(process.env.CHAIN_RPC_URL));
  const wallet = new Wallet(unwrap(process.env.WALLET_KEY), l2Provider);
  const paymasterAddress = process.env.PAYMASTER_ADDRESS;
  winston.info(
    `Wallet ${wallet.address} balance is ${ethers.formatEther(await l2Provider.getBalance(wallet.address))}`
  );
  new SimpleTxFlow(l2Provider, wallet, paymasterAddress, 5 * MIN).run();
};

collectDefaultMetrics();

const app = express();

app.get("*", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

app.listen(+(process.env.METRICS_PORT ?? 8080), "0.0.0.0");

main();
