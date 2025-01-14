import "dotenv/config";
import { MaxInt256, parseEther } from "ethers";
import winston from "winston";
import { utils } from "zksync-ethers";
import { ETH_ADDRESS_IN_CONTRACTS } from "zksync-ethers/build/utils";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { BigNumberish, BytesLike, Overrides } from "ethers";
import type { types, Wallet } from "zksync-ethers";
import type { Address } from "zksync-ethers/build/types";

const DEPOSIT_INTERVAL = 60; // 300sec

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

export class DepositFlow {
  private metricRecorder: FlowMetricRecorder;

  constructor(private wallet: Wallet) {
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
          recordStepGas(estimatedGas);
          return {
            ...populated,
            overrides: {
              gasLimit: estimatedGas,
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
        stepTimeoutMs: 5 * MIN,
        fn: async ({ recordStepGas, recordStepGasCost }) => {
          await depositHandle.wait(1);
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

  private async getLastDepositTimestamp(): Promise<number> {
    /// filter for deposit events from our wallet
    const l1BridgeContracts = await this.wallet.getL1BridgeContracts();
    const filter = l1BridgeContracts.shared.filters.BridgehubDepositBaseTokenInitiated(void 0, this.wallet.address);

    // query only last 50k blocks to handle provider limits
    const topBlock = await this.wallet._providerL1().getBlockNumber();
    const events = await l1BridgeContracts.shared.queryFilter(filter, topBlock - 50 * 1000, topBlock);
    events.sort((a, b) => b.blockNumber - a.blockNumber);
    return events.length > 0 ? (await events[0].getBlock()).timestamp : 0;
  }

  public async run() {
    const lastDepositTimestamp = await this.getLastDepositTimestamp();
    const currentBlockchainTimestamp = unwrap(
      await this.wallet
        ._providerL1()
        .getBlock("latest")
        .then((block) => block?.timestamp)
    );
    const timeSinceLastDeposit = currentBlockchainTimestamp - lastDepositTimestamp;
    if (timeSinceLastDeposit < DEPOSIT_INTERVAL) {
      const waitTime = DEPOSIT_INTERVAL - timeSinceLastDeposit;
      winston.info(`Waiting ${waitTime} seconds before starting deposit flow`);
      await new Promise((resolve) => setTimeout(resolve, waitTime * SEC));
    }
    while (true) {
      await this.step();
      await new Promise((resolve) => setTimeout(resolve, DEPOSIT_INTERVAL * SEC));
    }
  }
}
