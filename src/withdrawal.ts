import "dotenv/config";

import winston from "winston";

import { L2_EXECUTION_TIMEOUT } from "./configs";
import { FlowMetricRecorder, StatusNoSkip } from "./flowMetric";
import { SEC, unwrap, timeoutPromise } from "./utils";
import { WITHDRAWAL_RETRY_INTERVAL, WITHDRAWAL_RETRY_LIMIT, WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { Mutex } from "./lock";
import type { Wallet } from "zksync-ethers";

const FLOW_NAME = "withdrawal";

export class WithdrawalFlow extends WithdrawalBaseFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(
    wallet: Wallet,
    paymasterAddress: string | undefined,
    private l2WalletLock: Mutex,
    private intervalMs: number
  ) {
    super(wallet, paymasterAddress, FLOW_NAME);
    this.metricRecorder = new FlowMetricRecorder(FLOW_NAME);
  }

  protected async executeWatchdogWithdrawal(): Promise<StatusNoSkip> {
    try {
      this.metricRecorder.recordFlowStart();

      const populatedWithOverrides = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const tx = await this.wallet._providerL2().getWithdrawTx(this.getWithdrawalRequest());
          const nonce = await this.wallet.getNonce("latest");
          const populated = await this.wallet.populateTransaction({
            ...tx,
            nonce,
          });

          recordStepGas(unwrap(populated.gasLimit));
          recordStepGasPrice(unwrap(populated.maxFeePerGas));
          recordStepGasCost(BigInt(unwrap(populated.gasLimit)) * BigInt(unwrap(populated.maxFeePerGas)));

          return populated;
        },
      });

      // send L2 withdrawal transaction
      const withdrawalHandle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 10 * SEC,
        fn: () => this.wallet.sendTransaction(populatedWithOverrides),
      });
      winston.info(`[withdrawal] Tx (L2: ${withdrawalHandle.hash}) sent on L2`);

      // wait for transaction to be included in L2 block
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: L2_EXECUTION_TIMEOUT,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const receipt = await withdrawalHandle.wait();
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGasCost(BigInt(unwrap(receipt.gasUsed)) * BigInt(unwrap(receipt.gasPrice)));
        },
      });

      winston.info(`[withdrawal] Tx (L2: ${withdrawalHandle.hash}) included in L2 block`);
      this.metricRecorder.recordFlowSuccess();
      return StatusNoSkip.OK;
    } catch (e) {
      winston.error(`[withdrawal] Error during flow execution: ${unwrap(e)}`);
      this.metricRecorder.recordFlowFailure();
      return StatusNoSkip.FAIL;
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution("latest", this.wallet.address);
    const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
    const timeSinceLastWithdrawalSec = currentBlockchainTimestamp - (lastExecution?.timestampL2 ?? 0);
    if (lastExecution != null) this.metricRecorder.recordPreviousExecutionStatus(StatusNoSkip.OK);
    if (timeSinceLastWithdrawalSec < this.intervalMs / SEC) {
      const waitTime = this.intervalMs - timeSinceLastWithdrawalSec * SEC;
      winston.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting withdrawal flow`);
      await timeoutPromise(waitTime);
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      for (let i = 0; i < WITHDRAWAL_RETRY_LIMIT; i++) {
        const result = await this.l2WalletLock.withLock(() => this.executeWatchdogWithdrawal());
        if (result === StatusNoSkip.FAIL) {
          winston.warn(
            `[withdrawal] attempt ${i + 1} of ${WITHDRAWAL_RETRY_LIMIT} failed` +
              (i + 1 != WITHDRAWAL_RETRY_LIMIT
                ? `, retrying in ${(WITHDRAWAL_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                : "")
          );
          await timeoutPromise(WITHDRAWAL_RETRY_INTERVAL);
        } else {
          winston.info(`[withdrawal] attempt ${i + 1} succeeded`);
          break;
        }
      }
      await nextExecutionWait;
    }
  }
}
