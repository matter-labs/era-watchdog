import "dotenv/config";
import { Counter, Gauge } from "prom-client";
import winston from "winston";
import { utils } from "zksync-ethers";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { types, Provider, Wallet } from "zksync-ethers";

export class SimpleTxFlow {
  private metric_gas_price: Gauge;
  private legacy_metric_tx_gas: Gauge;
  private legacy_metric_tx_latency: Gauge;
  private legacy_metric_tx_latency_total: Gauge;
  private legacy_metric_tx_send_status: Gauge;
  private legacy_metric_tx_status: Gauge;
  private legacy_metric_liveness: Counter;
  private metricRecorder: FlowMetricRecorder;

  constructor(
    private provider: Provider,
    private wallet: Wallet,
    private paymasterAddress: string | undefined,
    private intervalMs: number
  ) {
    this.metricRecorder = new FlowMetricRecorder("transfer");
    this.metric_gas_price = new Gauge({ name: "gas_price", help: "Gas price on L2" });
    this.legacy_metric_tx_gas = new Gauge({
      name: "watchdog_tx_gas",
      help: "Simple transfer gas estimate",
      labelNames: ["type"],
    });
    this.legacy_metric_tx_latency = new Gauge({
      name: "watchdog_tx_latency",
      help: "Simple transfer latency",
      labelNames: ["stage"],
    });
    this.legacy_metric_tx_latency_total = new Gauge({
      name: "watchdog_tx_latency_total",
      help: "Simple transfer total latency",
    });
    this.legacy_metric_tx_send_status = new Gauge({
      name: "watchdog_tx_send_status",
      help: "Simple transfer send status",
    });
    this.legacy_metric_liveness = new Counter({
      name: "watchdog_liveness",
      help: "Watchdog liveness. Increases on failures.",
    });
    this.legacy_metric_tx_status = new Gauge({ name: "watchdog_tx_status", help: "Simple transfer status" });
  }

  protected getTxRequest(): types.TransactionRequest {
    if (this.paymasterAddress != null) {
      const paymasterParams = utils.getPaymasterParams(this.paymasterAddress, {
        type: "General",
        innerInput: new Uint8Array(),
      });
      return {
        to: this.wallet.address,
        value: 1, // just 1 wei
        customData: {
          gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
          paymasterParams,
        },
      };
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
      this.metricRecorder.recordFlowStart();

      // gas price metric
      const maxFeePerGas = await this.provider.getFeeData().then((feeData) => feeData.gasPrice ?? feeData.maxFeePerGas);
      this.metric_gas_price.set(Number(unwrap(maxFeePerGas)));

      // populate transaction
      const tx = this.getTxRequest();
      const populated = await this.metricRecorder.stepExecution({
        stepName: "populate_transaction",
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas }) => {
          const populated = await this.wallet.populateTransaction(tx);
          recordStepGas(unwrap(populated.gasLimit));
          return populated;
        },
      });
      this.legacy_metric_tx_gas.set({ type: "gas_estimate" }, Number(unwrap(populated.gasLimit)));
      this.legacy_metric_tx_latency.set({ stage: "estimate_gas" }, this.metricRecorder.legacyGetLastStepLatecy());

      // send transaction
      const txResponse = await this.metricRecorder.stepExecution({
        stepName: "send_transaction",
        stepTimeoutMs: 10 * SEC,
        fn: () => this.wallet.sendTransaction(populated),
      });
      send_success = 1;
      this.legacy_metric_tx_latency.set({ stage: "send_transaction" }, this.metricRecorder.legacyGetLastStepLatecy());

      // wait for transaction
      const txReceipt = await this.metricRecorder.stepExecution({
        stepName: "mempool",
        stepTimeoutMs: 1 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const receipt = await txResponse.wait(1);
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGasCost(BigInt(unwrap(receipt.gasUsed)) * BigInt(unwrap(receipt.gasPrice)));
          return receipt;
        },
      }); // included in a block
      this.legacy_metric_tx_latency.set({ stage: "mempool" }, this.metricRecorder.legacyGetLastStepLatecy());
      this.legacy_metric_tx_gas.set({ type: "gas_used" }, Number(unwrap(txReceipt?.gasUsed)));
      this.legacy_metric_tx_status.set(Number(unwrap(txReceipt?.status)));

      this.metricRecorder.recordFlowSuccess();
      this.legacy_metric_tx_latency_total.set(this.metricRecorder.legacyGetLastExecutionTotalLatency());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("simple tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
    } finally {
      this.legacy_metric_tx_send_status.set(send_success);
      this.legacy_metric_liveness.inc();
    }
  }

  public async run() {
    while (true) {
      await this.step();
      //sleep
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }
}
