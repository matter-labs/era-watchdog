import { JsonRpcProvider as EthersJsonRpcProvider } from "ethers";
import winston from "winston";
import { Provider as ZkSyncProvider } from "zksync-ethers";
import { IBridgehub__factory } from "zksync-ethers/build/typechain";

import type { Networkish, Provider as EthersProvider, TransactionReceipt, JsonRpcApiProviderOptions } from "ethers";
import type { Fee, TransactionRequest } from "zksync-ethers/build/types";

const npmLevels = winston.config.npm.levels;
/** Whether the default winston logger would actually emit at `level`. */
const levelEnabled = (level: string): boolean => npmLevels[level] <= npmLevels[winston.level ?? "info"];

const bigintReplacer = (_: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/** Optional auth token getter for Prividium (Authorization: Bearer). */
export type AuthTokenGetter = () => string | null;

/**
 * Ethers JsonRpcProvider that can be given an auth token getter for Prividium.
 */
class AuthableEthersJsonRpcProvider extends EthersJsonRpcProvider {
  declare readonly rpcUrl?: string;
  getAuthToken?: AuthTokenGetter;

  constructor(url?: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(url, network, options);
    this.rpcUrl = url;
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }
}

/**
 * Custom Provider wrapper that logs all JSON-RPC calls
 */
class ZkSyncOsProvider extends ZkSyncProvider {
  private l1Provider: EthersProvider | null = null;
  private isZKsyncOS = false;
  protected readonly rpcUrl: string;
  getAuthToken?: AuthTokenGetter;

  constructor(url: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(url, network, options);
    this.rpcUrl = url;
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }

  setIsZKsyncOS(isZKsyncOS: boolean) {
    this.isZKsyncOS = isZKsyncOS;
  }

  setL1Provider(l1Provider: EthersProvider) {
    this.l1Provider = l1Provider;
  }

  /// method overriden to use L1 calls instead of zks_ method for compatibility with ZKsync OS
  override async getBaseTokenContractAddress(): Promise<string> {
    const bridgehubAddress = await this.getBridgehubContractAddress();
    const bridgehub = IBridgehub__factory.connect(bridgehubAddress, this.l1Provider);
    const chainId = (await this.getNetwork()).chainId;
    return await bridgehub.baseToken(chainId);
  }

  override async estimateFee(transaction: TransactionRequest): Promise<Fee> {
    if (!this.isZKsyncOS) {
      return super.estimateFee(transaction);
    } else {
      const gasPrice = await this.getGasPrice();
      return {
        gasLimit: 0n, // return smth, it shouldn't be used
        gasPerPubdataLimit: 1n,
        maxPriorityFeePerGas: 0n,
        maxFeePerGas: gasPrice * 2n,
      };
    }
  }

  /**
   * Override send method to intercept and log JSON-RPC calls
   */
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRpcUrl(provider: any): string | undefined {
  return provider.rpcUrl ?? provider._getConnection?.()?.url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<T = object> = new (...args: any[]) => T;

const LoggingProviderMixing = <TBase extends Ctor<EthersJsonRpcProvider>>(Base: TBase) => {
  return class LoggingProvider extends Base {
    private requestId: number = 1;

    override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
      const id = this.requestId++;
      const self = this as typeof this & { getAuthToken?: AuthTokenGetter };

      // Guard the JSON.stringify: it runs on every RPC call and is otherwise
      // discarded by the level filter (prod runs at "info").
      if (levelEnabled("debug")) {
        winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
          rpcRequest: { id, method, params: JSON.stringify(params, bigintReplacer) },
        });
      }

      const startTime = Date.now();
      try {
        let result: unknown;
        const token = self.getAuthToken?.();

        const url = getRpcUrl(self);

        if (token && url) {
          result = await sendAuthorizedRpcRequest(url, token, id, method, params);
        } else {
          result = await super.send(method, params);
        }

        const duration = Date.now() - startTime;
        winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
          rpcResponse: {
            id,
            method,
          },
        });
        // Log the full response result at a lower level to avoid cluttering logs, but still have it available for debugging when needed.
        // Stringifying every response is expensive (large RPC results), so only do it when silly logging is actually enabled.
        if (levelEnabled("silly")) {
          winston.silly(`[JSON-RPC Response Result] ID: ${id} Method: ${method}`, {
            rpcResponse: { id, method, result: JSON.stringify(result, bigintReplacer) },
          });
        }

        return result;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        const duration = Date.now() - startTime;

        winston.error(`[JSON-RPC Error] ID: ${id} Method: ${method} Duration: ${duration}ms Error: ${error.message}`, {
          rpcError: {
            id,
            method,
            error: error.message,
            code: error.code,
            data: error.data,
          },
        });

        throw error;
      }
    }

    override async waitForTransaction(
      hash: string,
      _confirms?: null | number,
      timeout?: null | number
    ): Promise<null | TransactionReceipt> {
      const confirms = _confirms != null ? _confirms : 1;
      if (confirms === 0) {
        return this.getTransactionReceipt(hash);
      }

      const deadline = timeout != null ? Date.now() + timeout : null;
      const pollMs = this.pollingInterval;

      for (;;) {
        try {
          // Cheap inclusion probe: the raw JSON-RPC result is not parsed into ethers
          // objects, so no per-log address checksumming (keccak256) happens while
          // polling. The receipt is only formatted once, after it is confirmed.
          const raw = (await this.send("eth_getTransactionReceipt", [hash])) as { blockNumber?: string } | null;
          if (raw?.blockNumber != null) {
            if (confirms <= 1) {
              return this.getTransactionReceipt(hash);
            }
            const current = await this.getBlockNumber();
            if (current - Number(raw.blockNumber) + 1 >= confirms) {
              return this.getTransactionReceipt(hash);
            }
          }
        } catch (error) {
          winston.error("Error in waitForTransaction", error);
        }

        if (deadline != null && Date.now() >= deadline) {
          throw new Error("timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  };
};

async function sendAuthorizedRpcRequest(
  url: string,
  token: string,
  id: number,
  method: string,
  params: unknown[] | Record<string, unknown>
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: Array.isArray(params) ? params : params === undefined ? [] : [params],
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const data = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (!res.ok || data.error) {
    const err = new Error(data.error?.message ?? `RPC ${res.status}`) as Error & {
      code?: number;
      data?: unknown;
    };
    err.code = data.error?.code;
    err.data = data.error;
    throw err;
  }
  return data.result;
}

export const LoggingZkSyncProvider = LoggingProviderMixing(ZkSyncOsProvider);
export const LoggingEthersJsonRpcProvider = LoggingProviderMixing(AuthableEthersJsonRpcProvider);
