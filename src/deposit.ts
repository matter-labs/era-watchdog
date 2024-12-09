import "dotenv/config";
import { Gauge } from "prom-client";
import winston from "winston";

import { withLatency } from "./utils";

import type { BigNumberish, BytesLike, Overrides } from "ethers";
import { Provider, types, Wallet, utils } from "zksync-ethers";
import { FlowMetricRecorder } from "./flowMetric";

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

const FLOW_NAME = "deposit";

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
    let success = 0;
    try {
      this.metricRecorder.recordFlowStart();

      const populated = this.getDepositRequest();

      //TODO deposit price

      //TODO populate transaction
      
      // send L1 deposit transaction
      const { return: depositHandle, latency: send_latency } = await withLatency(() => this.wallet.deposit(populated));
      this.metric_latency.set({ stage: "send_transaction", flow: FLOW_NAME }, send_latency);
      winston.info(`Deposit tx (L1: ${depositHandle.hash}) sent on L1 in ${send_latency}s`);

      // wait for transaction
      const { return: txReceipt, latency: mempool_time } = await withLatency(() => depositHandle.waitL1Commit(1)); // included in a block on L1
      this.metric_latency.set({ stage: "l1_mempool", flow: FLOW_NAME }, mempool_time);
      //this.metric_gas.set({ type: "l1_gas_used" }, Number(unwrap(txReceipt?.gasUsed)));
      const l2TxHash = utils.getL2HashFromPriorityOp(
        txReceipt,
        await this.wallet._providerL2().getMainContractAddress()
      );
      const txHashs = `(L1: ${depositHandle.hash}, L2: ${l2TxHash})`;
      winston.info(`Deposit tx ${txHashs} mined on l1 in ${mempool_time}s`);

      // wait for deposit to be finalized
      const { latency: l2_time } = await withLatency(() => depositHandle.wait(1));
      winston.info(`deposit tx ${txHashs} mined on L2 in ${l2_time}s`);
      this.metric_latency.set({ stage: "l2_inclusion", flow: FLOW_NAME }, l2_time);
      const timeTotal = (Date.now() - timeStart) / 1000; // in seconds
      this.metric_latency_total.set(timeTotal);
      success = 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      winston.error("simple tx error: " + error?.message, error?.stack);
    } finally {
      this.metric_status.set({ flow: FLOW_NAME }, success);
    }
  }

  public async run() {
    while (true) {
      await this.step();
      await new Promise((resolve) => setTimeout(resolve, DEPOSIT_INTERVAL));
    }
  }
}
