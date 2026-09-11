import "dotenv/config";

import {
  createClient,
  createFinalizationServices,
  createWithdrawalProtocolService,
} from "@matterlabs/zksync-js/ethers";
import { Gauge } from "prom-client";
import { L2_BASE_TOKEN_ADDRESS, isAddressEq } from "zksync-ethers/build/utils";

import { Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";
import { WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { WithdrawalProtocol } from "@matterlabs/zksync-js/core";
import type { FinalizationServices, WithdrawalProtocolService } from "@matterlabs/zksync-js/ethers";
import type { AbstractProvider, BigNumberish } from "ethers";
import type { Wallet } from "zksync-ethers";

const FLOW_NAME = "withdrawalFinalize";
const FINALIZE_INTERVAL = +(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL ?? 15 * MIN);

/**
 * Pre-v26 ecosystems finalize on the legacy `L1SharedBridge.finalizeWithdrawal`. That contract
 * predates the SDK's protocol model, so it keeps its own code path here.
 */
const PRE_V26_BRIDGES = process.env.PRE_V26_BRIDGES === "1";

const WITHDRAWAL_PROTOCOLS = ["legacy-withdrawal", "interop-bundle"] as const;

/**
 * Optional override for the withdrawal protocol the chain speaks.
 *
 * The SDK normally detects this from the chain's own protocol version, falling back to a bytecode
 * probe. Both probes describe the L2, so they are wrong for a chain whose L1 ecosystem contracts
 * have already been upgraded to v32 while the chain itself is still registered as v31: the L1
 * entry points the legacy protocol needs (`L1Nullifier.finalizeDeposit`,
 * `isWithdrawalFinalized`) are gone, but detection still reports `legacy-withdrawal`. Set this to
 * `interop-bundle` on such a chain.
 */
function readProtocolOverride(): WithdrawalProtocol | undefined {
  const raw = process.env.WITHDRAWAL_PROTOCOL?.trim();
  if (raw == null || raw === "") return undefined;
  if (!(WITHDRAWAL_PROTOCOLS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid WITHDRAWAL_PROTOCOL "${raw}", expected one of: ${WITHDRAWAL_PROTOCOLS.join(", ")}`);
  }
  return raw as WithdrawalProtocol;
}

export class WithdrawalFinalizeFlow extends WithdrawalBaseFlow {
  private metricTimeSinceLastFinalizableWithdrawal: Gauge;
  private metricTimeSinceLastFinalizedBlock: Gauge;
  private chainId!: BigNumberish;
  private finalizationServices?: FinalizationServices;
  private protocolService?: WithdrawalProtocolService;
  private loggedProtocol?: WithdrawalProtocol;

  constructor(
    wallet: Wallet,
    isZKsyncOS: boolean,
    private intervalMs: number = FINALIZE_INTERVAL,
    /**
     * L1 provider for the SDK client. `Wallet._providerL1()` is declared as the narrower
     * `ethers.Provider` interface, which the SDK's `AbstractProvider` parameter does not accept,
     * so the concrete provider built in `main` is threaded through instead.
     */
    private l1Provider?: AbstractProvider
  ) {
    super(wallet, undefined, isZKsyncOS, FLOW_NAME);
    this.metricTimeSinceLastFinalizableWithdrawal = new Gauge({
      name: "watchdog_time_since_last_finalizable_withdrawal",
      help: "Blockchain second since last finalizable withdrawal transaction on L2",
    });
    this.metricTimeSinceLastFinalizedBlock = new Gauge({
      name: "watchdog_time_since_last_finalized_block",
      help: "Real second since last finalized block on L2",
    });
  }

  /**
   * Resolve the protocol once per process and log it when it first becomes known, so the chosen
   * finalization path is visible without having to read a revert trace.
   */
  private async resolveProtocol(): Promise<WithdrawalProtocol> {
    const service = unwrap(this.protocolService);
    const detection = await service.detect();
    if (this.loggedProtocol !== detection.protocol) {
      this.loggedProtocol = detection.protocol;
      this.logger.info(`Withdrawal protocol resolved to "${detection.protocol}" (via ${detection.source.via})`);
    }
    return detection.protocol;
  }

  /**
   * Simulate finalization on the protocol the chain actually speaks.
   *
   * v31 and below finalize on `L1Nullifier.finalizeDeposit`; v32 and above replaced that with
   * `L1InteropHandler.executeBundle`, having removed the old entry points outright. The SDK hides
   * the split behind one pair of calls, so both are covered by the same simulation here.
   */
  private async simulateViaSdk(withdrawalHash: string): Promise<Status> {
    const services = unwrap(this.finalizationServices);
    await this.resolveProtocol();

    const { finalization } = await this.metricRecorder.stepExecution({
      stepName: STEPS.get_finalization_params,
      stepTimeoutMs: 10 * SEC,
      fn: async () => services.fetchFinalization(withdrawalHash as `0x${string}`),
    });

    if (await services.isWithdrawalFinalized(finalization)) {
      this.logger.info(`Withdrawal ${withdrawalHash} is already finalized, skipping simulation`);
      this.metricRecorder.recordFlowSkipped();
      return Status.SKIP;
    }

    await this.metricRecorder.stepExecution({
      stepName: STEPS.l1_simulation,
      stepTimeoutMs: 10 * SEC,
      fn: async ({ recordStepGas }) => {
        const estimate = await services.estimateFinalization(finalization);
        recordStepGas(estimate.gasLimit);
      },
    });

    return Status.OK;
  }

  /** Legacy pre-v26 shared bridge: `L1SharedBridge.finalizeWithdrawal`. */
  private async simulateViaLegacySharedBridge(withdrawalHash: string): Promise<Status> {
    const { l1BatchNumber, l2MessageIndex, l2TxNumberInBlock, message, sender, proof } =
      await this.metricRecorder.stepExecution({
        stepName: STEPS.get_finalization_params,
        stepTimeoutMs: 10 * SEC,
        fn: async () => this.wallet.getFinalizeWithdrawalParams(withdrawalHash),
      });

    if (!isAddressEq(sender, L2_BASE_TOKEN_ADDRESS)) {
      throw new Error(`Withdrawal ${withdrawalHash} is not a base token withdrawal`);
    }

    if (await this.wallet.isWithdrawalFinalized(withdrawalHash)) {
      this.logger.info(`Withdrawal ${withdrawalHash} is already finalized, skipping simulation`);
      this.metricRecorder.recordFlowSkipped();
      return Status.SKIP;
    }

    const bridges = await this.wallet.getL1BridgeContracts();
    await this.metricRecorder.stepExecution({
      stepName: STEPS.l1_simulation,
      stepTimeoutMs: 10 * SEC,
      fn: async ({ recordStepGas }) => {
        const gas = await bridges.shared.finalizeWithdrawal.estimateGas(
          this.chainId,
          l1BatchNumber as BigNumberish,
          l2MessageIndex as BigNumberish,
          l2TxNumberInBlock as BigNumberish,
          message,
          proof
        );
        recordStepGas(gas);
      },
    });

    return Status.OK;
  }

  protected async executeWithdrawalFinalize(): Promise<Status> {
    try {
      const execution = await this.getLastExecution("finalized", this.wallet.address);
      const blockTimestamp = await this.getCurrentChainTimestamp();
      const finalizedBlockTimestamp = await this.getLatestFinalizedBlockTimestamp();
      this.metricRecorder.recordFlowStart();

      if (!execution) {
        this.logger.warn("No withdrawal found to try finalize");
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }
      const withdrawalHash = execution.l2Receipt.hash;

      this.metricTimeSinceLastFinalizableWithdrawal.set(blockTimestamp - execution.timestampL2);
      this.metricTimeSinceLastFinalizedBlock.set(new Date().getTime() / 1000 - finalizedBlockTimestamp);

      this.logger.info(`Simulating finalization for withdrawal hash: ${withdrawalHash}`);

      const status = PRE_V26_BRIDGES
        ? await this.simulateViaLegacySharedBridge(withdrawalHash)
        : await this.simulateViaSdk(withdrawalHash);

      if (status === Status.SKIP) return status;

      this.logger.info(`Finalization simulation for withdrawal ${withdrawalHash} successful`);

      this.metricRecorder.recordFlowSuccess();
      return Status.OK;
    } catch (e) {
      this.logger.error(`Error during flow execution: ${unwrap(e)}`);
      this.metricRecorder.recordFlowFailure();
      return Status.FAIL;
    }
  }

  public async run() {
    this.logger.info(`Starting withdrawal finalize flow with interval ${this.intervalMs / MIN} minutes`);
    this.chainId = (await this.wallet._providerL2().getNetwork()).chainId;

    if (!PRE_V26_BRIDGES) {
      const client = createClient({
        l1: unwrap(this.l1Provider),
        l2: this.wallet._providerL2(),
        signer: this.wallet._signerL1(),
      });
      this.protocolService = createWithdrawalProtocolService(client, readProtocolOverride());
      this.finalizationServices = createFinalizationServices(client, this.protocolService);
    }

    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      await this.executeWithdrawalFinalize();
      await nextExecutionWait;
    }
  }
}
