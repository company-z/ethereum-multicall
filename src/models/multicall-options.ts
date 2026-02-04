import { Provider } from '@ethersproject/providers';

interface MulticallOptionsBase {
  multicallCustomContractAddress?: string;
  tryAggregate?: boolean;
  networkId?: number;
  /**
   * Maximum number of calls per batch. If set, large call sets will be
   * split into multiple parallel RPC requests. Default: unlimited.
   */
  batchSize?: number;
  /**
   * Use undici for high-performance HTTP requests (Node.js only).
   * Only applies when using nodeUrl (custom JSON-RPC provider).
   * Provides 2-3x throughput improvement via connection pooling.
   */
  useUndici?: boolean;
}

export interface MulticallOptionsWeb3 extends MulticallOptionsBase {
  // so we can support any version of web3 typings
  // tslint:disable-next-line: no-any
  web3Instance: any;
}

export interface MulticallOptionsEthers extends MulticallOptionsBase {
  ethersProvider: Provider;
}

export interface MulticallOptionsCustomJsonRpcProvider
  extends MulticallOptionsBase {
  nodeUrl: string;
}
