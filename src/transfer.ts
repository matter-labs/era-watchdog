import "dotenv/config";
import winston from "winston";
import { utils } from "zksync-ethers";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, timeoutPromise, unwrap } from "./utils";

import type { STATUS } from "./flowMetric";
import type { types, Provider, Wallet } from "zksync-ethers";

const FLOW_RETRY_LIMIT = +(process.env.FLOW_RETRY_LIMIT ?? 5);
const FLOW_RETRY_INTERVAL = +(process.env.FLOW_RETRY_INTERVAL ?? 5 * SEC);

export class SimpleTxFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(
    private provider: Provider,
    private wallet: Wallet,
    private paymasterAddress: string | undefined,
    private intervalMs: number
  ) {
    this.metricRecorder = new FlowMetricRecorder("transfer");
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

  protected async step(): Promise<STATUS> {
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
      return "OK";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("simple tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
      return "FAIL";
    }
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      for (let i = 0; i < FLOW_RETRY_LIMIT; i++) {
        const result = await this.step();
        if (result === "OK") {
          winston.info(`[transfer] attempt ${i + 1} succeeded`);
          break;
        } else {
          winston.error(`[transfer] attempt ${i + 1} failed`);
        }
        await timeoutPromise(FLOW_RETRY_INTERVAL);
      }
      //sleep
      await nextExecutionWait;
    }
  }
}
