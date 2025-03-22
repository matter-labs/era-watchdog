import "dotenv/config";
import { Gauge } from "prom-client";
import winston from "winston";
import { utils } from "zksync-ethers";

import { DEPOSIT_RETRY_INTERVAL, DEPOSIT_RETRY_LIMIT, DepositBaseFlow, STEPS } from "./depositBase";
import { FlowMetricRecorder } from "./flowMetric";
import { SEC, timeoutPromise, unwrap } from "./utils";

import type { ExecutionResultKnown } from "./depositBase";
import type { STATUS } from "./flowMetric";
import type { Wallet } from "zksync-ethers";
import type { IL1ERC20Bridge, IL1SharedBridge } from "zksync-ethers/build/typechain";

const FLOW_NAME = "depositUser";
export class DepositUserFlow extends DepositBaseFlow {
  private metricRecorder: FlowMetricRecorder;
  private lastOnChainOperationTimestamp: number = 0;
  private metricTimeSinceLastDeposit: Gauge;

  constructor(
    wallet: Wallet,
    l1BridgeContracts: {
      erc20: IL1ERC20Bridge;
      weth: IL1ERC20Bridge;
      shared: IL1SharedBridge;
    },
    chainId: bigint,
    baseToken: string,
    private intervalMs: number,
    private txTriggerDelayMs: number
  ) {
    super(wallet, l1BridgeContracts, chainId, baseToken, FLOW_NAME);
    this.metricRecorder = new FlowMetricRecorder(FLOW_NAME);
    this.metricTimeSinceLastDeposit = new Gauge({
      name: "watchdog_time_since_last_deposit",
      help: "Blockchain second since last deposit transaction on L1",
    });
  }

  private recordDepositResult(result: ExecutionResultKnown) {
    if (result.status === "OK") {
      this.metricRecorder.manualRecordStatus(result.status, unwrap(result.timestampL2) - result.timestampL1);
      this.metricRecorder.manualRecordStepCompletion(
        STEPS.l1_execution,
        0, // not latency for L1 available
        result.timestampL1
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l1_execution, result.l1Receipt.gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l1_execution, result.l1Receipt.gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l1_execution,
        result.l1Receipt.gasUsed * result.l1Receipt.gasPrice
      );
      this.metricRecorder.manualRecordStepCompletion(
        STEPS.l2_execution,
        unwrap(result.timestampL2) - result.timestampL1,
        unwrap(result.timestampL2)
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l2_execution, unwrap(result.l2Receipt).gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l2_execution, unwrap(result.l2Receipt).gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l2_execution,
        unwrap(result.l2Receipt).gasUsed * unwrap(result.l2Receipt).gasPrice
      );
      this.metricTimeSinceLastDeposit.set(result.secSinceL1Deposit);
      winston.info(
        `[depositUser] Reported successful deposit. L1 hash: ${result.l1Receipt.hash}, L2 hash: ${
          result.l2Receipt?.hash
        }`
      );
    } else if (result.status === "FAIL") {
      winston.info(
        `[depositUser] Reported failed deposit. L1 hash: ${result.l1Receipt.hash}, L2 hash: ${result.l2Receipt?.hash}`
      );
      this.metricRecorder.manualRecordStatus(result.status, 0);
    } else {
      const _impossible: never = result.status;
      throw new Error(`Unexpected status ${result.status}`);
    }
  }

  private async executeDepositTx(): Promise<STATUS> {
    try {
      this.lastOnChainOperationTimestamp = await this.getCurrentChainTimestamp();
      const depositHandle = await this.wallet.deposit(this.getDepositRequest());
      winston.info(`[depositUser] Deposit transaction sent ${depositHandle.hash}`);
      const txReceipt = await depositHandle.waitL1Commit(1);
      const l2TxHash = utils.getL2HashFromPriorityOp(
        txReceipt,
        await this.wallet._providerL2().getMainContractAddress()
      );
      winston.info(`[depositUser] Deposit transaction mined on L1, expecting L2 hash: ${l2TxHash}`);
      await depositHandle.wait(1);
      winston.info("[depositUser] Deposit transaction mined on L2. Checking status...");
      const watchdogTxResult = await this.getLastExecution(this.wallet.address);
      if (watchdogTxResult.status == null) {
        throw new Error(`Just executed deposit not found ${JSON.stringify(watchdogTxResult)}`);
      }
      this.recordDepositResult(watchdogTxResult);
      return watchdogTxResult.status;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("[depositUser] watchdog deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.manualRecordStatus("FAIL", 0);
      return "FAIL";
    }
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
      const someDepositResult = await this.getLastExecution(void 0);
      // we only report OK. On fail we want perform a deposit manually as we cannot rely on users doing deposits properly
      let shouldPerformManualDeposit: boolean = false;
      switch (someDepositResult.status) {
        case "OK": {
          this.recordDepositResult(someDepositResult);
          const timeSinceLastDeposit = currentBlockchainTimestamp - someDepositResult.timestampL1;
          if (timeSinceLastDeposit * SEC > this.txTriggerDelayMs) {
            winston.info(
              `[depositUser] Last users deposit was successful, but it was ${timeSinceLastDeposit} seconds ago. Will execute deposit tx manually.`
            );
            shouldPerformManualDeposit = true;
          }
          break;
        }
        case "FAIL":
          shouldPerformManualDeposit = true;
          break;
        case null:
          shouldPerformManualDeposit = true;
          break;
        default: {
          const _impossible: never = someDepositResult;
          throw new Error(`Unexpected status ${someDepositResult["status"]}`);
        }
      }
      if (shouldPerformManualDeposit) {
        winston.info("[depositUser] Checking for last MANUAL deposit...");
        const lastOurExecution = await this.getLastExecution(this.wallet.address);
        // we take max with last onchain operation timestamp in case onchain operations are failing on L1 to avoid disrespecting retry limit
        const timeSinceLastOurDeposit =
          currentBlockchainTimestamp - Math.max(lastOurExecution.timestampL1, this.lastOnChainOperationTimestamp);
        if (timeSinceLastOurDeposit * SEC > this.txTriggerDelayMs) {
          winston.info("[depositUser] Starting manual deposit transaction");
          for (let i = 0; i < DEPOSIT_RETRY_LIMIT; i++) {
            const result = await this.executeDepositTx();
            if (result === "OK") {
              winston.info(`[depositUser] attempt ${i + 1} succeeded`);
              break;
            } else {
              winston.error(
                `[depositUser] Deposit failed on try ${i + 1}/${DEPOSIT_RETRY_LIMIT}` +
                  (i + 1 != DEPOSIT_RETRY_LIMIT
                    ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                    : "")
              );
              await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
            }
          }
        } else {
          winston.info(
            `[depositUser] Last manual deposit was ${timeSinceLastOurDeposit} seconds ago. Reporting last status of ${lastOurExecution.status}`
          );
          if (lastOurExecution.status != null) this.recordDepositResult(lastOurExecution);
        }
      }

      await nextExecutionWait;
    }
  }
}
