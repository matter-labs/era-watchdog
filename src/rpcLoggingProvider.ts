import { JsonRpcProvider as EthersJsonRpcProvider } from "ethers";
import winston from "winston";
import { Provider as ZkSyncProvider } from "zksync-ethers";
import { IBridgehub__factory } from "zksync-ethers/build/typechain";

import type { Networkish, Provider as EthersProvider, JsonRpcApiProviderOptions } from "ethers";
import type { Fee, TransactionRequest } from "zksync-ethers/build/types";

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

// `isLogLevelEnabled` isn't typed on the default-export shape, so compare
// priorities ourselves. Higher number = more verbose; a level is enabled when
// its priority is <= the configured logger level's priority.
function isLogLevelEnabled(level: string): boolean {
  const levels = winston.config.npm.levels as Record<string, number>;
  const configured = (winston as unknown as { level?: string }).level ?? "info";
  const target = levels[level];
  const current = levels[configured];
  if (target == null || current == null) return true;
  return target <= current;
}

const LoggingProviderMixing = <TBase extends Ctor<EthersJsonRpcProvider>>(Base: TBase) => {
  return class LoggingProvider extends Base {
    private requestId: number = 1;

    override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
      const id = this.requestId++;
      const self = this as typeof this & { getAuthToken?: AuthTokenGetter };

      if (isLogLevelEnabled("debug")) {
        winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
          rpcRequest: {
            id,
            method,
            params: JSON.stringify(params, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
          },
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
        if (isLogLevelEnabled("debug")) {
          winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
            rpcResponse: {
              id,
              method,
            },
          });
        }
        // Log the full response result at a lower level to avoid cluttering logs, but still have it available for debugging when needed
        if (isLogLevelEnabled("silly")) {
          winston.silly(`[JSON-RPC Response Result] ID: ${id} Method: ${method}`, {
            rpcResponse: {
              id,
              method,
              result: JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
            },
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
