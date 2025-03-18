import "dotenv/config";

import { formatEther, MaxInt256, parseEther } from "ethers";
import winston from "winston";
import { utils } from "zksync-ethers";
import { ETH_ADDRESS_IN_CONTRACTS } from "zksync-ethers/build/utils";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
} from "./depositBase";
import { FlowMetricRecorder } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";

import type { Status } from "./flowMetric";
import type { BigNumberish, BytesLike, Overrides } from "ethers";
import type { Wallet } from "zksync-ethers";
import type { IL1ERC20Bridge, IL1SharedBridge } from "zksync-ethers/build/typechain";
import type { Address } from "zksync-ethers/build/types";

const FLOW_NAME = "deposit";
type L2Request = {
  contractAddress: Address;
  calldata: string;
  l2GasLimit?: BigNumberish;
  mintValue?: BigNumberish;
  l2Value?: BigNumberish;
  factoryDeps?: BytesLike[];
  operatorTip?: BigNumberish;
  gasPerPubdataByte?: BigNumberish;
  refundRecipient?: Address;
  overrides?: Overrides;
};

export class DepositFlow extends DepositBaseFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(
    wallet: Wallet,
    l1BridgeContracts: {
      erc20: IL1ERC20Bridge;
      weth: IL1ERC20Bridge;
      shared: IL1SharedBridge;
    },
    chainId: bigint,
    baseToken: string,
    private intervalMs: number
  ) {
    super(wallet, l1BridgeContracts, chainId, baseToken, FLOW_NAME);
    this.metricRecorder = new FlowMetricRecorder(FLOW_NAME);
  }

  protected async executeWatchdogDeposit(): Promise<Status> {
    try {
      // even before flow start we check base token allowence and perform an infinitite approve if needed
      if (this.baseToken != ETH_ADDRESS_IN_CONTRACTS) {
        const allowance = await this.wallet.getAllowanceL1(this.baseToken);

        // heuristic condition to determine if we should perform the infinite approval
        if (allowance < parseEther("100000")) {
          winston.info(`[deposit] Approving base token ${this.baseToken} for infinite amount`);
          await this.wallet.approveERC20(this.baseToken, MaxInt256);
        } else {
          winston.info(`[deposit] Base token ${this.baseToken} already has approval`);
        }
        const balance = await this.wallet.getBalanceL1(this.baseToken);
        winston.info(`[deposit] Base token ${this.baseToken} balance: ${formatEther(balance.toString())}`);
      }

      this.metricRecorder.recordFlowStart();

      const populatedWithOverrides = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas, recordStepGasCost, recordStepGasPrice }) => {
          const populated: L2Request = await this.wallet.getDepositTx(this.getDepositRequest());
          const estimatedGas = await this.wallet.estimateGasRequestExecute(populated);
          const nonce = await this.wallet._signerL1().getNonce("latest");
          const feeData = await this.wallet._providerL1().getFeeData();
          recordStepGas(estimatedGas);
          recordStepGasPrice(unwrap(feeData.maxFeePerGas));
          recordStepGasCost(estimatedGas * unwrap(feeData.maxFeePerGas));
          return {
            ...populated,
            overrides: {
              gasLimit: estimatedGas,
              nonce,
              maxFeePerGas: unwrap(feeData.maxFeePerGas), // we expect to be post EIP-1559
              maxPriorityFeePerGas: unwrap(feeData.maxPriorityFeePerGas),
            },
          };
        },
      });
      // record l2 estimates using the manual record function
      this.metricRecorder.manualRecordStepGas(STEPS.l2_estimation, unwrap(populatedWithOverrides.l2GasLimit));
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l2_estimation,
        BigInt(unwrap(populatedWithOverrides.mintValue)) - BigInt(unwrap(populatedWithOverrides.l2Value))
      );
      if (populatedWithOverrides.overrides.maxFeePerGas > DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI) {
        winston.warn(
          `[deposit] Gas price ${populatedWithOverrides.overrides.maxFeePerGas} is higher than limit ${DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI}. Skipping deposit`
        );
        this.metricRecorder.recordFlowSkipped();
        return "SKIP";
      }

      // send L1 deposit transaction
      const depositHandle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 30 * SEC,
        fn: () => this.wallet.requestExecute(populatedWithOverrides),
      });
      winston.info(`[deposit] Tx (L1: ${depositHandle.hash}) sent on L1`);

      // wait for transaction
      const txReceipt = await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_execution,
        stepTimeoutMs: 3 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const txReceipt = await depositHandle.waitL1Commit(1);
          recordStepGas(unwrap(txReceipt?.gasUsed));
          recordStepGasPrice(unwrap(txReceipt?.gasPrice));
          recordStepGasCost(unwrap(txReceipt?.gasUsed) * unwrap(txReceipt?.gasPrice));
          return txReceipt;
        },
      }); // included in a block on L1

      const l2TxHash = utils.getL2HashFromPriorityOp(
        txReceipt,
        await this.wallet._providerL2().getMainContractAddress()
      );
      const txHashs = `(L1: ${depositHandle.hash}, L2: ${l2TxHash})`;
      winston.info(`[deposit] Tx ${txHashs} mined on l1`);
      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGasPrice, recordStepGas, recordStepGasCost }) => {
          const receipt = await depositHandle.wait(1);
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasCost(unwrap(receipt.gasUsed) * unwrap(receipt.gasPrice));
        },
      });
      winston.info(`[deposit] Tx ${txHashs} mined on L2`);

      this.metricRecorder.recordFlowSuccess();
      return "OK";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
      return "FAIL";
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution(this.wallet.address);
    const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
    const timeSinceLastDepositSec = currentBlockchainTimestamp - lastExecution.timestampL1;
    if (lastExecution.status != null) this.metricRecorder.recordPreviousExecutionStatus(lastExecution.status!);
    if (timeSinceLastDepositSec < this.intervalMs / SEC) {
      const waitTime = this.intervalMs - timeSinceLastDepositSec * SEC;
      winston.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting deposit flow`);
      await timeoutPromise(waitTime);
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      let attempt: number = 1;
      while (attempt <= DEPOSIT_RETRY_LIMIT) {
        const result = await this.executeWatchdogDeposit();
        switch (result) {
          case "OK":
            winston.info(`[deposit] attempt ${attempt} succeeded`);
            break;
          case "SKIP":
            winston.info(`[deposit] attempt ${attempt} skipped (not counted towards limit)`);
            break;
          case "FAIL": {
            attempt++;
            winston.warn(
              `[deposit] attempt ${attempt} of ${DEPOSIT_RETRY_LIMIT} failed` +
                (attempt != DEPOSIT_RETRY_LIMIT
                  ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                  : "")
            );
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
            break;
          }
          default: {
            const _exhaustiveCheck: never = result;
            throw new Error(`Unreachable code branch: ${_exhaustiveCheck}`);
          }
        }
        if (result == "OK") break;
      }
      await nextExecutionWait;
    }
  }
}
