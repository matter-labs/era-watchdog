import "dotenv/config";
import winston from "winston";
import { utils } from "zksync-ethers";

import { FlowMetricRecorder } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { BigNumberish, BytesLike, Overrides } from "ethers";
import type { types, Wallet } from "zksync-ethers";

const DEPOSIT_INTERVAL = 300000; // 300sec

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
      this.metricRecorder.recordFlowStart();

      const populated = this.getDepositRequest();

      //TODO deposit price

      //TODO populate transaction

      // send L1 deposit transaction
      const depositHandle = await this.metricRecorder.stepExecution({
        stepName: "send_transaction",
        stepTimeoutMs: 30 * SEC,
        fn: () => this.wallet.deposit(populated),
      });
      winston.info(`Deposit tx (L1: ${depositHandle.hash}) sent on L1`);

      // wait for transaction
      const txReceipt = await this.metricRecorder.stepExecution({
        stepName: "l1_mempool",
        stepTimeoutMs: 3 * MIN,
        fn: () => depositHandle.waitL1Commit(1),
      }); // included in a block on L1
      //this.metric_gas.set({ type: "l1_gas_used" }, Number(unwrap(txReceipt?.gasUsed)));
      const l2TxHash = utils.getL2HashFromPriorityOp(
        txReceipt,
        await this.wallet._providerL2().getMainContractAddress()
      );
      const txHashs = `(L1: ${depositHandle.hash}, L2: ${l2TxHash})`;
      winston.info(`Deposit tx ${txHashs} mined on l1`);

      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: "l2_inclusion",
        stepTimeoutMs: 5 * MIN,
        fn: () => depositHandle.wait(1),
      });
      winston.info(`deposit tx ${txHashs} mined on L2`);

      this.metricRecorder.recordFlowSuccess();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("simple tx error: " + error?.message, error?.stack);
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
      await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
    }
    while (true) {
      await this.step();
      await new Promise((resolve) => setTimeout(resolve, DEPOSIT_INTERVAL));
    }
  }
}
