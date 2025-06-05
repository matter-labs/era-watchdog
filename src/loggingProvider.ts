import winston from "winston";
import { Provider as ZkSyncProvider } from "zksync-ethers";

/**
 * Custom Provider wrapper that logs all JSON-RPC calls
 */
export class LoggingZkSyncProvider extends ZkSyncProvider {
  private requestId: number = 1;

  constructor(url: string) {
    // Pass the URL to the parent class constructor
    super(url);
  }

  /**
   * Override send method to intercept and log JSON-RPC calls
   */
  override async send(method: string, params: Array<any>): Promise<any> {
    const id = this.requestId++;
    
    winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
      rpcRequest: {
        id,
        method,
        params: JSON.stringify(params, (_, value) => 
          typeof value === 'bigint' ? value.toString() : value
        )
      }
    });
    
    const startTime = Date.now();
    try {
      // Call the parent class's send method directly
      const result = await super.send(method, params);
      const duration = Date.now() - startTime;
      
      winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
        rpcResponse: {
          id,
          result: JSON.stringify(result, (_, value) => 
            typeof value === 'bigint' ? value.toString() : value
          )
        }
      });
      
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      winston.error(`[JSON-RPC Error] ID: ${id} Method: ${method} Duration: ${duration}ms Error: ${error.message}`, {
        rpcError: {
          id,
          error: error.message,
          code: error.code,
          data: error.data
        }
      });
      
      throw error;
    }
  }
}


