import "dotenv/config";
import { Gauge } from "prom-client";
import winston from "winston";
import { utils } from "zksync-ethers";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { types, Provider, Wallet } from "zksync-ethers";

export class SimpleTxFlow {
  private metric_gas_price: Gauge;
  private metricRecorder: FlowMetricRecorder;

  constructor(
    private provider: Provider,
    private wallet: Wallet,
    private paymasterAddress: string | undefined,
    private intervalMs: number
  ) {
    this.metricRecorder = new FlowMetricRecorder("transfer");
    this.metric_gas_price = new Gauge({ name: "gas_price", help: "Gas price on L2" });
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
    try {
      this.metricRecorder.recordFlowStart();

      // gas price metric
      const maxFeePerGas = await this.provider.getFeeData().then((feeData) => feeData.gasPrice ?? feeData.maxFeePerGas);
      this.metric_gas_price.set(Number(unwrap(maxFeePerGas)));

      // populate transaction
      const tx = this.getTxRequest();
      const populated = await this.metricRecorder.stepExecution({
        stepName: "estimation",
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas }) => {
          const populated = await this.wallet.populateTransaction(tx);
          recordStepGas(unwrap(populated.gasLimit));
          return populated;
        },
      });

      // send transaction
      const txResponse = await this.metricRecorder.stepExecution({
        stepName: "send",
        stepTimeoutMs: 10 * SEC,
        fn: () => this.wallet.sendTransaction(populated),
      });

      // wait for transaction
      await this.metricRecorder.stepExecution({
        stepName: "execution",
        stepTimeoutMs: 1 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const receipt = await txResponse.wait(1);
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGasCost(BigInt(unwrap(receipt.gasUsed)) * BigInt(unwrap(receipt.gasPrice)));
          return receipt;
        },
      }); // included in a block

      this.metricRecorder.recordFlowSuccess();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("simple tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
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
