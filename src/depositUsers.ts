import "dotenv/config";
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
  private lastOnChainOperaionTimestamp: number = 0;

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
  }

  private recordDepositResult(result: ExecutionResultKnown) {
    if (result.status === "OK") {
      this.metricRecorder.manualRecordStatus(result.status, unwrap(result.timestampL2) - result.timestampL1);
      this.metricRecorder.manualRecordStepCompletion(
        "l2_execution",
        unwrap(result.timestampL2) - result.timestampL1,
        unwrap(result.timestampL2)
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l1_execution, result.l1Receipt.gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l1_execution, result.l1Receipt.gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l1_execution,
        result.l1Receipt.gasUsed * result.l1Receipt.gasPrice
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l2_execution, unwrap(result.l2Receipt).gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l2_execution, unwrap(result.l2Receipt).gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l2_execution,
        unwrap(result.l2Receipt).gasUsed * unwrap(result.l2Receipt).gasPrice
      );
    } else if (result.status === "FAIL") {
      this.metricRecorder.manualRecordStatus(result.status, 0);
    } else {
      const _impossible: never = result.status;
      throw new Error(`Unexpected status ${result.status}`);
    }
  }

  private async executeDepositTx(): Promise<STATUS> {
    try {
      this.lastOnChainOperaionTimestamp = await this.getCurrentChainTimestamp();
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
        throw new Error(`Just executed deposit not found ${watchdogTxResult}`);
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
      if (someDepositResult.status != null) {
        this.recordDepositResult(someDepositResult);
      }
      // we take max with last onchain operation timestamp in case onchain operations are fialing on L1 to avoid direspecting retry limit
      const timeSinceLastDeposit =
        currentBlockchainTimestamp - Math.max(someDepositResult.timestampL1, this.lastOnChainOperaionTimestamp);
      if (timeSinceLastDeposit * SEC > this.txTriggerDelayMs) {
        winston.info(
          `[depositUser] No deposit detected in the last ${timeSinceLastDeposit} seconds, starting deposit transaction`
        );
        for (let i = 0; i < DEPOSIT_RETRY_LIMIT; i++) {
          const result = await this.executeDepositTx();
          if (result === "OK") {
            break;
          } else {
            winston.error(`[depositUser] Deposit failed, retries ${i + 1}/${DEPOSIT_RETRY_LIMIT}`);
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
          }
        }
      }
      await nextExecutionWait;
    }
  }
}
