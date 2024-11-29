import "dotenv/config";
import { Gauge } from "prom-client";
import winston from "winston";
import { utils } from "zksync-ethers";

import { withLatency } from "./utils";

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

const FLOW_NAME = "deposit";

export class DepositFlow {
  private metric_latency: Gauge;
  private metric_latency_total: Gauge;
  private metric_status: Gauge;

  constructor(private wallet: Wallet) {
    // metric for deposit price
    this.metric_latency = new Gauge({
      name: "watchdog_latency",
      help: "Watchdog latency for all flows",
      labelNames: ["flow", "stage"],
    });
    this.metric_latency_total = new Gauge({
      name: "watchdog_latency_total",
      help: "Watchdog latency total for all flows",
      labelNames: ["flow"],
    });
    this.metric_status = new Gauge({ name: "watchdog_status", help: "Watchdog flow status", labelNames: ["flow"] });
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
      const timeStart = Date.now();

      const populated = this.getDepositRequest();

      //TODO deposit price

      //TODO populate transaction

      // send L1 deposit transaction
      const { return: depositHandle, latency: send_latency } = await withLatency(() => this.wallet.deposit(populated));
      this.metric_latency.set({ stage: "send_transaction", flow: FLOW_NAME }, send_latency);
      winston.info(`tx sent in ${send_latency}s`);

      // wait for transaction
      const { return: txReceipt, latency: mempool_time } = await withLatency(() => depositHandle.waitL1Commit(1)); // included in a block on L1
      this.metric_latency.set({ stage: "l1_mempool", flow: FLOW_NAME }, mempool_time);
      //this.metric_gas.set({ type: "l1_gas_used" }, Number(unwrap(txReceipt?.gasUsed)));
      winston.info(`deposit mined on l1 in ${mempool_time}s`);

      // wait for deposit to be finalized
      const { return: depositReceipt, latency: l2_time } = await withLatency(() => depositHandle.waitFinalize());
      winston.info(`deposit finalized in ${l2_time}s`);
      winston.debug(`Deposit receipt ${JSON.stringify(depositReceipt)}`);
      this.metric_latency.set({ stage: "l2_finalization", flow: FLOW_NAME }, l2_time);
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
