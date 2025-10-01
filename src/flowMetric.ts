import { Gauge, Histogram } from "prom-client";

import { withTimeout } from "./utils";

import type { Logger } from "winston";

export const StatusNoSkip = {
  OK: "OK",
  FAIL: "FAIL",
} as const;
export type StatusNoSkip = (typeof StatusNoSkip)[keyof typeof StatusNoSkip];

export const Status = {
  ...StatusNoSkip,
  SKIP: "SKIP",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/// singleton for metric storage
class FlowMetricStore {
  public metric_latency: Gauge;
  public metric_step_timestamp: Gauge; //in ms
  public metric_latency_total: Gauge;
  public metric_status: Gauge;
  public metric_status_hist: Histogram;
  public metric_step_gas: Gauge;
  public metric_step_gas_price: Gauge;
  public metric_step_gas_cost: Gauge;

  constructor() {
    this.metric_latency = new Gauge({
      name: "watchdog_latency",
      help: "Watchdog step latencies for all flows",
      labelNames: ["flow", "stage"],
    });
    this.metric_latency_total = new Gauge({
      name: "watchdog_latency_total",
      help: "Watchdog latency totals for all flows",
      labelNames: ["flow"],
    });
    this.metric_status = new Gauge({ name: "watchdog_status", help: "Watchdog flow status", labelNames: ["flow"] });
    this.metric_status_hist = new Histogram({
      name: "watchdog_status_hist",
      help: "Watchdog flow status histogram",
      labelNames: ["flow"],
    });
    this.metric_step_timestamp = new Gauge({
      name: "watchdog_step_timestamp",
      help: "Watchdog last step completion timestamp in ms for all flows",
      labelNames: ["flow", "step"],
    });
    this.metric_step_gas = new Gauge({
      name: "watchdog_step_gas",
      help: "Watchdog step gas",
      labelNames: ["flow", "step"],
    });
    this.metric_step_gas_price = new Gauge({
      name: "watchdog_step_gas_price",
      help: "Watchdog step gas price (either limit or actualy used)",
      labelNames: ["flow", "step"],
    });
    this.metric_step_gas_cost = new Gauge({
      name: "watchdog_step_gas_cost",
      help: "Watchdog step gas cost (price * used)",
      labelNames: ["flow", "step"],
    });
  }
}
const store = new FlowMetricStore();

type Numberish = number | bigint | string;

export class FlowMetricRecorder {
  startTime: number | null = null;
  private _lastStepLatency: number | null = null;
  private _lastExecutionTotalLatency: number | null = null;
  constructor(
    private flowName: string,
    private logger: Logger
  ) {}

  public recordFlowStart() {
    this.startTime = Date.now();
    this.logger.info("Flow started");
  }

  public async stepExecution<T>({
    stepName,
    stepTimeoutMs,
    fn,
  }: {
    stepName: string;
    stepTimeoutMs: number;
    fn: (helpers: {
      recordStepGas: (gas: Numberish) => void;
      recordStepGasPrice: (price: Numberish) => void;
      recordStepGasCost: (cost: Numberish) => void;
    }) => Promise<T>;
  }): Promise<T> {
    const start = Date.now();
    const helpers = {
      recordStepGas: (gas: Numberish) => {
        store.metric_step_gas.set({ flow: this.flowName, step: stepName }, Number(gas));
      },
      recordStepGasPrice: (price: Numberish) => {
        store.metric_step_gas_price.set({ flow: this.flowName, step: stepName }, Number(price));
      },
      recordStepGasCost: (cost: Numberish) => {
        store.metric_step_gas_cost.set({ flow: this.flowName, step: stepName }, Number(cost));
      },
    };
    const ret = await withTimeout(fn(helpers), stepTimeoutMs, `step ${stepName}`);
    const end = Date.now();
    const latency = (end - start) / 1000; // in seconds
    store.metric_latency.set({ flow: this.flowName, stage: stepName }, latency);
    this._lastStepLatency = latency;
    store.metric_step_timestamp.set({ flow: this.flowName, step: stepName }, end);
    this.logger.info(`Step ${stepName} took ${latency} seconds`);
    return ret;
  }

  public recordFlowSuccess() {
    if (this.startTime) {
      const endTime = Date.now();
      const latency = (endTime - this.startTime) / 1000; // in seconds
      store.metric_latency_total.set({ flow: this.flowName }, latency);
      store.metric_status.set({ flow: this.flowName }, 1);
      store.metric_status_hist.observe({ flow: this.flowName }, 1);
      this._lastExecutionTotalLatency = latency;
      this.startTime = null;
      this.logger.info(`Flow completed in ${latency} seconds`);
    } else {
      throw new Error("Flow start was not recorded");
    }
  }

  public recordFlowSkipped() {
    if (this.startTime) {
      const endTime = Date.now();
      const latency = (endTime - this.startTime) / 1000; // in seconds
      store.metric_status.set({ flow: this.flowName }, 0.5);
      this.startTime = null;
      this.logger.info(`Flow skipped after ${latency} seconds`);
    } else {
      throw new Error("Flow start was not recorded");
    }
  }

  public recordFlowFailure() {
    store.metric_status.set({ flow: this.flowName }, 0);
    store.metric_status_hist.observe({ flow: this.flowName }, 0);
    this.startTime = null;
    this.logger.error("Flow failed");
  }

  /// MANUAL FUNCTIONS
  /// Needed for recording based solly on onchain data
  public manualRecordStatus(status: Status, latencyTotalSec: number) {
    store.metric_status.set({ flow: this.flowName }, status === Status.OK ? 1 : 0);
    store.metric_status_hist.observe({ flow: this.flowName }, status === Status.OK ? 1 : 0);
    if (status === Status.OK) {
      store.metric_latency_total.set({ flow: this.flowName }, latencyTotalSec);
      this._lastExecutionTotalLatency = latencyTotalSec;
    }
  }

  public manualRecordStepCompletion(stepName: string, latencySec: number, stepEndSec: number) {
    store.metric_latency.set({ flow: this.flowName, stage: stepName }, latencySec);
    this._lastStepLatency = latencySec;
    store.metric_step_timestamp.set({ flow: this.flowName, step: stepName }, stepEndSec * 1000);
    this.logger.info(`Step ${stepName} took ${latencySec} seconds`);
  }

  public manualRecordStepGas(stepName: string, gas: Numberish) {
    store.metric_step_gas.set({ flow: this.flowName, step: stepName }, Number(gas));
  }

  public manualRecordStepGasPrice(stepName: string, price: Numberish) {
    store.metric_step_gas_price.set({ flow: this.flowName, step: stepName }, Number(price));
  }

  public manualRecordStepGasCost(stepName: string, cost: Numberish) {
    store.metric_step_gas_cost.set({ flow: this.flowName, step: stepName }, Number(cost));
  }

  public recordPreviousExecutionStatus(status: StatusNoSkip) {
    switch (status) {
      case Status.OK: {
        store.metric_status.set({ flow: this.flowName }, 1);
        store.metric_status_hist.observe({ flow: this.flowName }, 1);
        break;
      }
      case Status.FAIL: {
        store.metric_status_hist.observe({ flow: this.flowName }, 0);
        break;
      }
      default: {
        const _: never = status;
        throw new Error("Impossible: " + status);
      }
    }
  }
}
