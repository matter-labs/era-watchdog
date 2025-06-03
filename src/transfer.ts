import "dotenv/config";
import { utils } from "zksync-ethers";

import { BaseFlow } from "./baseFlow";
import { L2_EXECUTION_TIMEOUT } from "./configs";
import { StatusNoSkip } from "./flowMetric";
import { SEC, timeoutPromise, unwrap } from "./utils";

import type { Mutex } from "./lock";
import type { types, Provider, Wallet } from "zksync-ethers";

const FLOW_NAME = "transfer";
const TRANSFER_RETRY_LIMIT = +(process.env.FLOW_TRANSFER_RETRY_LIMIT ?? 5);
const TRANSFER_RETRY_INTERVAL = +(process.env.FLOW_TRANSFER_RETRY_INTERVAL ?? 5 * SEC);

export class SimpleTxFlow extends BaseFlow {
  constructor(
    private provider: Provider,
    private wallet: Wallet,
    private l2WalletLock: Mutex,
    private paymasterAddress: string | undefined,
    private intervalMs: number
  ) {
    super(FLOW_NAME);
  }

  protected getTxRequest(): types.TransactionRequest {
    if (this.paymasterAddress != null) {
      const paymasterParams = utils.getPaymasterParams(this.paymasterAddress, {
        type: "General",
        innerInput: new Uint8Array(),
      });
      return {
        to: this.wallet.address,
        value: 0, // in paymaster scenario we may not have any funds
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

  protected async step(): Promise<StatusNoSkip> {
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
        stepTimeoutMs: L2_EXECUTION_TIMEOUT,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const receipt = await txResponse.wait(1);
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGasCost(BigInt(unwrap(receipt.gasUsed)) * BigInt(unwrap(receipt.gasPrice)));
          return receipt;
        },
      }); // included in a block

      this.metricRecorder.recordFlowSuccess();
      return StatusNoSkip.OK;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error("simple tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
      return StatusNoSkip.FAIL;
    }
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      for (let i = 0; i < TRANSFER_RETRY_LIMIT; i++) {
        const result = await this.l2WalletLock.withLock(() => this.step());
        if (result === StatusNoSkip.OK) {
          this.logger.info(`attempt ${i + 1} succeeded`);
          break;
        } else {
          this.logger.error(`attempt ${i + 1} failed`);
        }
        await timeoutPromise(TRANSFER_RETRY_INTERVAL);
      }
      //sleep
      await nextExecutionWait;
    }
  }
}
