import winston from "winston";
import { Provider as ZkSyncProvider } from "zksync-ethers";
import { IBridgehub__factory } from "zksync-ethers/build/typechain";

import type { Provider as EthersProvider } from "ethers";

/**
 * Custom Provider wrapper that logs all JSON-RPC calls
 */
export class LoggingZkSyncProvider extends ZkSyncProvider {
  private requestId: number = 1;
  private l1Provider: EthersProvider | null = null;

  constructor(url: string) {
    // Pass the URL to the parent class constructor
    super(url);
  }

  setL1Provider(l1Provider: EthersProvider) {
    this.l1Provider = l1Provider;
  }

  override async getBaseTokenContractAddress(): Promise<string> {
    const bridgehubAddress = await this.getBridgehubContractAddress();
    const bridgehub = IBridgehub__factory.connect(bridgehubAddress, this.l1Provider);
    const chainId = (await this.getNetwork()).chainId;
    return await bridgehub.baseToken(chainId);
  }

  /**
   * Override send method to intercept and log JSON-RPC calls
   */
  override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    const id = this.requestId++;

    winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
      rpcRequest: {
        id,
        method,
        params: JSON.stringify(params, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
      },
    });

    const startTime = Date.now();
    try {
      // Call the parent class's send method directly
      const result = await super.send(method, params);
      const duration = Date.now() - startTime;

      winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
        rpcResponse: {
          id,
          method,
          result: JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
        },
      });

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
}
