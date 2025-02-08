import "dotenv/config";
import winston from "winston";
import { utils } from "zksync-ethers";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { types, Provider, Wallet } from "zksync-ethers";

export class SimpleTxFlow {
  private metricRecorder: FlowMetricRecorder;
  private gasPriceMultiplier: number = 1;

  constructor(
    private _provider: Provider,
    private wallet: Wallet,
    private paymasterAddress: string | undefined,
    private intervalMs: number
  ) {
    this.metricRecorder = new FlowMetricRecorder("transfer");
    if (process.env.L2_GAS_PRICE_MULTIPLIER != null) {
      this.gasPriceMultiplier = parseFloat(unwrap(process.env.L2_GAS_PRICE_MULTIPLIER));
      if (!(isFinite(this.gasPriceMultiplier) && this.gasPriceMultiplier > 0)) {
        throw new Error("Invalid L2_GAS_PRICE_MULTIPLIER");
      }
    }
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

      // populate transaction
      const tx = this.getTxRequest();
      const populated = await this.metricRecorder.stepExecution({
        stepName: "estimation",
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const latestNonce = await this.wallet.getNonce("latest");
          const populated = await this.wallet.populateTransaction({
            ...tx,
            nonce: latestNonce,
          });
          recordStepGasPrice(unwrap(populated.maxFeePerGas));
          recordStepGas(unwrap(populated.gasLimit));
          recordStepGasCost(BigInt(unwrap(populated.gasLimit)) * BigInt(unwrap(populated.maxFeePerGas)));
          populated.maxFeePerGas =
            (BigInt(unwrap(populated.maxFeePerGas)) * BigInt(this.gasPriceMultiplier * 1000000)) / 1000000n; // use a fractional hack-in floats with bigint multiplication
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
      const nextExecutionWait = new Promise((resolve) => setTimeout(resolve, this.intervalMs));
      await this.step();
      //sleep
      await nextExecutionWait;
    }
  }
}
