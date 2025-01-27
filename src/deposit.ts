import "dotenv/config";
import { MaxInt256, parseEther } from "ethers";
import winston from "winston";
import { utils } from "zksync-ethers";
import { ETH_ADDRESS_IN_CONTRACTS } from "zksync-ethers/build/utils";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { STATUS } from "./flowMetric";
import type { BigNumberish, BytesLike, Overrides } from "ethers";
import type { types, Wallet } from "zksync-ethers";
import type { Address } from "zksync-ethers/build/types";

type DepositTxRequest = {
  token: types.Address;
  amount: BigNumberish;
  to?: types.Address;
  operatorTip?: BigNumberish;
  bridgeAddress?: types.Address;
  approveERC20?: boolean;
  approveBaseERC20?: boolean;
  l2GasLimit?: BigNumberish;
  gasPerPubdataByte?: BigNumberish;
  refundRecipient?: types.Address;
  overrides?: Overrides;
  approveOverrides?: Overrides;
  approveBaseOverrides?: Overrides;
  customBridgeData?: BytesLike;
};

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

const PRIORITY_OP_TIMEOUT = +(process.env.FLOW_DEPOSIT_L2_TIMEOUT ?? 15 * MIN);

export class DepositFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(
    private wallet: Wallet,
    private intervalMs: number
  ) {
    this.metricRecorder = new FlowMetricRecorder("deposit");
  }

  protected getDepositRequest(): DepositTxRequest {
    return {
      to: this.wallet.address,
      token: utils.ETH_ADDRESS,
      amount: 1, // just 1 wei
    };
  }

  protected async step() {
    try {
      // even before flow start we check base token allowence and perform an infinitite approve if needed
      const baseToken = await this.wallet.getBaseToken();
      if (baseToken != ETH_ADDRESS_IN_CONTRACTS) {
        const allowance = await this.wallet.getAllowanceL1(baseToken);

        // heuristic condition to determine if we should perform the infinite approval
        if (allowance < parseEther("100000")) {
          winston.info(`Approving base token ${baseToken} for infinite amount`);
          await this.wallet.approveERC20(baseToken, MaxInt256);
        }
      }

      this.metricRecorder.recordFlowStart();

      const populated = await this.metricRecorder.stepExecution({
        stepName: "estimation",
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
      const depositHandle = await this.metricRecorder.stepExecution({
        stepName: "send",
        stepTimeoutMs: 30 * SEC,
        fn: () => this.wallet.requestExecute(populated),
      });
      winston.info(`Deposit tx (L1: ${depositHandle.hash}) sent on L1`);

      // wait for transaction
      const txReceipt = await this.metricRecorder.stepExecution({
        stepName: "l1_execution",
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
      winston.info(`Deposit tx ${txHashs} mined on l1`);
      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: "l2_execution",
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGas, recordStepGasCost }) => {
          await depositHandle.wait(1);
          // When performing a deposit
          // we l2 gas limit set as checking actual gas used does not make sense
          recordStepGas(BigInt(unwrap(populated.l2GasLimit)));
          // we used amount of minted tokens as a gas cost (minus transfered amount)
          recordStepGasCost(BigInt(unwrap(populated.mintValue)) - BigInt(unwrap(populated.l2Value)));
        },
      });
      winston.info(`deposit tx ${txHashs} mined on L2`);

      this.metricRecorder.recordFlowSuccess();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
    }
  }

  private async getLastExecution(): Promise<{
    timestamp: number;
    status: STATUS | null;
  }> {
    /// filter for deposit events from our wallet
    const l1BridgeContracts = await this.wallet.getL1BridgeContracts();
    const filter = l1BridgeContracts.shared.filters.BridgehubDepositBaseTokenInitiated(void 0, this.wallet.address);

    // query only last 50k blocks to handle provider limits
    const topBlock = await this.wallet._providerL1().getBlockNumber();
    const events = await l1BridgeContracts.shared.queryFilter(
      filter,
      topBlock - +(process.env.MAX_LOGS_BLOCKS ?? 50 * 1000),
      topBlock
    );
    events.sort((a, b) => b.blockNumber - a.blockNumber);
    if (events.length === 0)
      return {
        timestamp: 0,
        status: null,
      };
    const event = events[0];

    const timestamp = (await event.getBlock()).timestamp;
    const txReceipt = await event.getTransactionReceipt();
    const l2TxHash = utils.getL2HashFromPriorityOp(txReceipt, await this.wallet._providerL2().getMainContractAddress());
    winston.info(`[deposit] Previous deposit L2 TX hash ${l2TxHash}`);
    const receipt = await this.wallet._providerL2().waitForTransaction(l2TxHash, 1, PRIORITY_OP_TIMEOUT);
    if (receipt == null) {
      winston.error(`[deposit] Previous transaction not executed on l2: ${l2TxHash}`);
      return {
        timestamp,
        status: "FAIL",
      };
    } else if (receipt.status != 1) {
      winston.error(`[deposit] Previous transaction failed on l2: ${l2TxHash}`);
      return {
        timestamp,
        status: "FAIL",
      };
    } else {
      winston.info(`[deposit] Previous transaction executed on l2: ${l2TxHash}`);
      return {
        timestamp,
        status: "OK",
      };
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution();
    const currentBlockchainTimestamp = unwrap(
      await this.wallet
        ._providerL1()
        .getBlock("latest")
        .then((block) => block?.timestamp)
    );
    const timeSinceLastDeposit = currentBlockchainTimestamp - lastExecution.timestamp;
    if (lastExecution.status != null) this.metricRecorder.recordPreviousExecutionStatus(lastExecution.status);
    if (timeSinceLastDeposit < this.intervalMs / SEC) {
      //TODO consider recovering status of last deposit
      const waitTime = this.intervalMs - timeSinceLastDeposit * SEC;
      winston.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting deposit flow`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    while (true) {
      const nextExecutionWait = new Promise((resolve) => setTimeout(resolve, this.intervalMs));
      await this.step();
      await nextExecutionWait;
    }
  }
}
