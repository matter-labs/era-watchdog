import "dotenv/config";

import { formatEther, MaxInt256, parseEther } from "ethers";
import winston from "winston";
import { utils } from "zksync-ethers";
import { ETH_ADDRESS_IN_CONTRACTS } from "zksync-ethers/build/utils";

import {
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
} from "./depositBase";
import { FlowMetricRecorder } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";

import type { STATUS } from "./flowMetric";
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

  protected async executeWatchdogDeposit(metricRecorder: FlowMetricRecorder): Promise<STATUS> {
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

      metricRecorder.recordFlowStart();

      const populatedWithOverrides = await metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas }) => {
          const populated: L2Request = await this.wallet.getDepositTx(this.getDepositRequest());
          const estimatedGas = await this.wallet.estimateGasRequestExecute(populated);
          const nonce = await this.wallet._signerL1().getNonce("latest");
          recordStepGas(estimatedGas);
          return {
            ...populated,
            overrides: {
              gasLimit: estimatedGas,
              nonce,
            },
          };
        },
      });

      // send L1 deposit transaction
      const depositHandle = await metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 30 * SEC,
        fn: () => this.wallet.requestExecute(populatedWithOverrides),
      });
      winston.info(`[deposit] Tx (L1: ${depositHandle.hash}) sent on L1`);

      // wait for transaction
      const txReceipt = await metricRecorder.stepExecution({
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
      await metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGas, recordStepGasCost }) => {
          await depositHandle.wait(1);
          // When performing a deposit
          // we l2 gas limit set as checking actual gas used does not make sense
          recordStepGas(BigInt(unwrap(populatedWithOverrides.l2GasLimit)));
          // we used amount of minted tokens as a gas cost (minus transfered amount)
          recordStepGasCost(
            BigInt(unwrap(populatedWithOverrides.mintValue)) - BigInt(unwrap(populatedWithOverrides.l2Value))
          );
        },
      });
      winston.info(`[deposit] Tx ${txHashs} mined on L2`);

      metricRecorder.recordFlowSuccess();
      return "OK";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("deposit tx error: " + error?.message, error?.stack);
      metricRecorder.recordFlowFailure();
      return "FAIL";
    }
  }

  public async run() {
    while (true) {
      const lastExecution = await this.getLastExecution(this.wallet.address);
      const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
      const timeSinceLastDeposit = currentBlockchainTimestamp - lastExecution.timestampL1;
      if (lastExecution.status != null) this.metricRecorder.recordPreviousExecutionStatus(lastExecution.status!);
      if (timeSinceLastDeposit < this.intervalMs / SEC) {
        //TODO consider recovering status of last deposit
        const waitTime = this.intervalMs - timeSinceLastDeposit * SEC;
        winston.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting deposit flow`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      while (true) {
        const nextExecutionWait = timeoutPromise(this.intervalMs);
        for (let i = 0; i < DEPOSIT_RETRY_LIMIT; i++) {
          const result = await this.executeWatchdogDeposit(this.metricRecorder);
          if (result === "FAIL") {
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
          } else break;
        }
        await nextExecutionWait;
      }
    }
  }
}
