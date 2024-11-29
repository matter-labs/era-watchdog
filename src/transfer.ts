import "dotenv/config";
import { toBigInt } from "ethers";
import { Counter, Gauge } from "prom-client";
import { Provider, utils, Wallet } from "zksync-ethers";

import { unwrap, withLatency } from "./utils";

import type { types } from "zksync-ethers";

const SIMPLE_TX_INTERVAL = 300000; // 300sec

export class SimpleTxFlow {
    private metric_gas_price: Gauge;
    private metric_tx_gas: Gauge;
    private metric_tx_latency: Gauge;
    private metric_tx_latency_total: Gauge;
    private metric_tx_send_status: Gauge;
    private metric_tx_status: Gauge;
    private metric_liveness: Counter;

    constructor(private provider: Provider, private wallet: Wallet, private paymasterAddress: string | undefined) {
        this.metric_gas_price = new Gauge({ name: "gas_price", help: "Gas price on L2" });
        this.metric_tx_gas = new Gauge({
            name: "watchdog_tx_gas",
            help: "Simple transfer gas estimate",
            labelNames: ["type"],
        });
        this.metric_tx_latency = new Gauge({
            name: "watchdog_tx_latency",
            help: "Simple transfer latency",
            labelNames: ["stage"],
        });
        this.metric_tx_latency_total = new Gauge({
            name: "watchdog_tx_latency_total",
            help: "Simple transfer total latency",
        });
        this.metric_tx_send_status = new Gauge({ name: "watchdog_tx_send_status", help: "Simple transfer send status" });
        this.metric_liveness = new Counter({
            name: "watchdog_liveness",
            help: "Watchdog liveness. Increases on failures.",
        });
        this.metric_tx_status = new Gauge({ name: "watchdog_tx_status", help: "Simple transfer status" });
    }

    protected getTxRequest(): types.TransactionRequest {
        if (this.paymasterAddress != null) {
            const paymasterParams = utils.getPaymasterParams(
                this.paymasterAddress,
                {
                    type: "General",
                    innerInput: new Uint8Array(),
                }
            )
            return {
                to: this.wallet.address,
                value: 1, // just 1 wei
                customData: {
                    gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
                    paymasterParams,
                }
            }
        } else {
            return {
                to: this.wallet.address,
                value: 1, // just 1 wei
            };
        }
    }

    protected async step() {
        let send_success = 0;
        try {
            const timeStart = Date.now();

            // gas price metric
            const maxFeePerGas = await this.provider.getFeeData().then((feeData) => feeData.gasPrice ?? feeData.maxFeePerGas);
            this.metric_gas_price.set(Number(unwrap(maxFeePerGas)));

            // populate transaction
            const tx = this.getTxRequest();
            const { return: populated, latency: estimate_letancy } = await withLatency(() => this.wallet.populateTransaction(tx));
            this.metric_tx_gas.set({ type: "gas_estimate" }, Number(toBigInt(unwrap(populated.gasLimit))));
            this.metric_tx_latency.set({ stage: "estimate_gas" }, estimate_letancy);

            // send transaction
            const { return: txResponse, latency: send_latency } = await withLatency(() => this.wallet.sendTransaction(populated));
            send_success = 1;
            this.metric_tx_latency.set({ stage: "send_transaction" }, send_latency);
            console.log("tx sent in", send_latency, "s");

            // wait for transaction
            const { return: txReceipt, latency: mempool_time } = await withLatency(() => txResponse.wait(1)); // included in a block
            this.metric_tx_latency.set({ stage: "mempool" }, mempool_time);
            this.metric_tx_gas.set({ type: "gas_used" }, Number(unwrap(txReceipt?.gasUsed)));
            this.metric_tx_status.set(Number(unwrap(txReceipt?.status)));
            console.log("tx mined in", mempool_time, "s");

            const timeTotal = (Date.now() - timeStart) / 1000; // in seconds
            this.metric_tx_latency_total.set(timeTotal);
        } catch (e) {
            console.error("tx failed", e);
        } finally {
            this.metric_tx_send_status.set(send_success);
            this.metric_liveness.inc();
        }
    }

    public async run() {
        while (true) {
            await this.step();
            // sleep 300sec
            await new Promise((resolve) => setTimeout(resolve, SIMPLE_TX_INTERVAL));
        }
    }
}