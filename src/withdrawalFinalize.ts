import "dotenv/config";

import winston from "winston";
import { L2_BASE_TOKEN_ADDRESS, isAddressEq } from "zksync-ethers/build/utils";

import { FlowMetricRecorder } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";
import { WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { STATUS } from "./flowMetric";
import type { BigNumberish } from "ethers";
import type { Wallet } from "zksync-ethers";

const FLOW_NAME = "withdrawalFinalize";
const FINALIZE_INTERVAL = +(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL ?? 15 * MIN);
const PRE_V26_BRIDGES = process.env.PRE_V26_BRIDGES === "1";

export class WithdrawalFinalizeFlow extends WithdrawalBaseFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(
    wallet: Wallet,
    paymasterAddress: string | undefined,
    private intervalMs: number = FINALIZE_INTERVAL
  ) {
    super(wallet, paymasterAddress, FLOW_NAME);
    this.metricRecorder = new FlowMetricRecorder(FLOW_NAME);
  }

  private async getLatestWithdrawalHash(): Promise<string | null> {
    const execution = await this.getLastExecution("finalized", this.wallet.address);
    if (execution === null) {
      winston.info(`[${FLOW_NAME}] No finalized withdrawals found for ${this.wallet.address}`);
      return null;
    }

    return execution.l2Receipt.hash;
  }

  protected async executeWithdrawalFinalize(): Promise<STATUS> {
    try {
      const withdrawalHash = await this.getLatestWithdrawalHash();
      this.metricRecorder.recordFlowStart();

      if (!withdrawalHash) {
        winston.error(`[${FLOW_NAME}] No withdrawal found to try finalize`);
        this.metricRecorder.recordFlowFailure();
        return "FAIL";
      }

      winston.info(`[${FLOW_NAME}] Simulating finalization for withdrawal hash: ${withdrawalHash}`);

      // Get finalization parameters
      const { l1BatchNumber, l2MessageIndex, l2TxNumberInBlock, message, sender, proof } =
        await this.metricRecorder.stepExecution({
          stepName: STEPS.get_finalization_params,
          stepTimeoutMs: 10 * SEC,
          fn: async () => {
            return this.wallet.getFinalizeWithdrawalParams(withdrawalHash);
          },
        });

      if (!isAddressEq(sender, L2_BASE_TOKEN_ADDRESS)) {
        throw new Error(`[${FLOW_NAME}] Withdrawal ${withdrawalHash} is not a base token withdrawal`);
      }

      // Determine the correct L1 bridge

      const bridges = await this.wallet.getL1BridgeContracts();
      if (PRE_V26_BRIDGES) {
        // Instead of sending a transaction, just simulate it with a static call
        await this.metricRecorder.stepExecution({
          stepName: STEPS.l1_simulation,
          stepTimeoutMs: 10 * SEC,
          fn: async ({ recordStepGas }) => {
            const gas = await bridges.shared.finalizeWithdrawal.estimateGas(
              (await this.wallet._providerL2().getNetwork()).chainId as BigNumberish,
              l1BatchNumber as BigNumberish,
              l2MessageIndex as BigNumberish,
              l2TxNumberInBlock as BigNumberish,
              message,
              proof
            );
            recordStepGas(gas);
          },
        });
      } else {
        throw new Error("V26 bridges are not supported");
      }

      winston.info(`[${FLOW_NAME}] Finalization simulation for withdrawal ${withdrawalHash} successful`);

      this.metricRecorder.recordFlowSuccess();
      return "OK";
    } catch (e) {
      winston.error(`[${FLOW_NAME}] Error during flow execution: ${unwrap(e)}`);
      this.metricRecorder.recordFlowFailure();
      return "FAIL";
    }
  }

  public async run() {
    winston.info(`[${FLOW_NAME}] Starting withdrawal finalize flow with interval ${this.intervalMs / MIN} minutes`);
    if (!PRE_V26_BRIDGES) {
      throw new Error("V26 bridges are not supported");
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      await this.executeWithdrawalFinalize();
      await nextExecutionWait;
    }
  }
}
