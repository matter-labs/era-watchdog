import "dotenv/config";
import { ethers } from "ethers";
import express from "express";
import { collectDefaultMetrics, register } from "prom-client";
import { Provider, Wallet } from "zksync-ethers";

import { unwrap } from "./utils";
import { SimpleTxFlow } from "./transfer";


const main = async () => {
    const l2Provider = new Provider(unwrap(process.env.CHAIN_RPC_URL));
    const wallet = new Wallet(unwrap(process.env.WALLET_KEY), l2Provider);
    const paymasterAddress = process.env.PAYMASTER_ADDRESS;
    console.log("Hello World! balance is", ethers.formatEther(await l2Provider.getBalance(wallet.address)));
    new SimpleTxFlow(l2Provider, wallet, paymasterAddress).run();
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
