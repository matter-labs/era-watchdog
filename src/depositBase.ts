import "dotenv/config";
import { id } from "ethers";
import winston from "winston";
import { utils } from "zksync-ethers";

import { MIN, SEC, unwrap } from "./utils";

import type { STATUS } from "./flowMetric";
import type { BigNumberish, BytesLike, Overrides, TransactionReceipt } from "ethers";
import type { types, Wallet } from "zksync-ethers";
import type { IL1ERC20Bridge, IL1SharedBridge } from "zksync-ethers/build/typechain";

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

export type ExecutionResultUnknown = { status: null; timestampL1: 0 };
export type ExecutionResultKnown = {
  secSinceL1Deposit: number;
  l1Receipt: TransactionReceipt;
  timestampL1: number;
  l2Receipt?: TransactionReceipt;
  timestampL2?: number;
  status: STATUS;
};
export type ExecutionResult = ExecutionResultUnknown | ExecutionResultKnown;

export const STEPS = {
  estimation: "estimation",
  send: "send",
  l1_execution: "l1_execution",
  l2_estimation: "l2_estimation", //dummy step, no actual execution time reported
  l2_execution: "l2_execution",
};

export const PRIORITY_OP_TIMEOUT = +(process.env.FLOW_DEPOSIT_L2_TIMEOUT ?? 15 * MIN);
export const DEPOSIT_RETRY_INTERVAL = +(process.env.FLOW_DEPOSIT_RETRY_INTERVAL ?? 30 * SEC);
export const DEPOSIT_RETRY_LIMIT = +(process.env.FLOW_DEPOSIT_RETRY_LIMIT ?? 3);

export abstract class DepositBaseFlow {
  constructor(
    protected wallet: Wallet,
    protected l1BridgeContracts: {
      erc20: IL1ERC20Bridge;
      weth: IL1ERC20Bridge;
      shared: IL1SharedBridge;
    },
    protected chainId: bigint,
    protected baseToken: string,
    private flowName: string
  ) {}

  protected getDepositRequest(): DepositTxRequest {
    return {
      to: this.wallet.address,
      token: this.baseToken,
      amount: 1, // just 1 wei
      refundRecipient: this.wallet.address,
    };
  }

  protected async getLastExecution(wallet: string | undefined): Promise<ExecutionResult> {
    // works only up to v25 due to event signature change
    const filter = this.l1BridgeContracts.shared.filters.BridgehubDepositBaseTokenInitiated(this.chainId, wallet);
    const topicFilter = await filter.getTopicFilter();
    // also accept the new signature
    topicFilter[0] = [
      topicFilter[0] as string,
      id("BridgehubDepositBaseTokenInitiated(uint256,address,bytes32,uint256)"),
    ];
    const topBlock = await this.wallet._providerL1().getBlockNumber();
    const blockchainTime = await this.getCurrentChainTimestamp();
    // actually filter structure got modified itself so we could use it, but lets not rely on such unexpected behaviour
    const events = await this.wallet._providerL1().getLogs({
      address: this.l1BridgeContracts.shared.target,
      topics: topicFilter,
      fromBlock: topBlock - +(process.env.MAX_LOGS_BLOCKS ?? 50 * 1000),
      toBlock: topBlock,
    });
    events.sort((a, b) => b.blockNumber - a.blockNumber);
    if (events.length === 0) {
      winston.info(`[${this.flowName}] No deposits found for ${wallet ?? "any wallet"}`);
      return {
        timestampL1: 0,
        status: null,
      };
    }
    const event = events[0];

    const timestampL1 = (await event.getBlock()).timestamp;
    const l1Receipt = await event.getTransactionReceipt();
    const l2TxHash = utils.getL2HashFromPriorityOp(l1Receipt, await this.wallet._providerL2().getMainContractAddress());
    const secSinceL1Deposit = blockchainTime - timestampL1;
    winston.info(
      `[${this.flowName}] Found deposit ${event.transactionHash} at ${new Date(timestampL1 * 1000).toUTCString()}, ${secSinceL1Deposit} seconds ago, expecting L2 TX hash ${l2TxHash}`
    );
    let l2Receipt: TransactionReceipt | null = null;
    try {
      l2Receipt = await this.wallet._providerL2().waitForTransaction(l2TxHash, 1, PRIORITY_OP_TIMEOUT);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      winston.error(
        `[${this.flowName}] ${event.transactionHash} error (${e?.message}) fetching l2 transaction: ${l2TxHash} `
      );
    }

    const l1Res = {
      secSinceL1Deposit,
      l1Receipt,
      timestampL1,
    };
    if (l2Receipt == null) {
      winston.error(`[${this.flowName}] ${event.transactionHash} not executed on l2: ${l2TxHash} `);
      return {
        ...l1Res,
        status: "FAIL",
      };
    } else if (l2Receipt.status != 1) {
      winston.error(`[${this.flowName}] ${event.transactionHash} failed on l2: ${l2TxHash} `);
      return {
        ...l1Res,
        status: "FAIL",
      };
    } else {
      const timestampL2 = (await l2Receipt.getBlock()).timestamp;
      winston.info(
        `[${this.flowName}] ${event.transactionHash} executed successfully on l2: ${l2TxHash} at ${new Date(timestampL2 * 1000).toUTCString()} `
      );
      return {
        ...l1Res,
        l2Receipt,
        timestampL2,
        status: "OK",
      };
    }
  }

  protected async getCurrentChainTimestamp(): Promise<number> {
    return unwrap(
      await this.wallet
        ._providerL1()
        .getBlock("latest")
        .then((block) => block?.timestamp)
    );
  }
}
