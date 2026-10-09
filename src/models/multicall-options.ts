import { Provider } from '@ethersproject/providers';

/**
 * Logger function type for timing logs.
 * @param message The log message (e.g., "phase: 10.00ms")
 * @param meta Optional metadata object with structured timing info
 */
export type TimingLogger = (message: string, meta?: Record<string, unknown>) => void;

/**
 * One structured log line: `message` for people, every value it interpolates
 * repeated as a field for queries.
 */
export interface MulticallLogEntry {
  message: string;
  [field: string]: unknown;
}

/**
 * Log sink for the library's own lines. Shaped like the object form of a
 * winston-style logger, so `@company-z/telemetry`'s `Logger` fits as-is.
 */
export interface MulticallLogger {
  debug(entry: MulticallLogEntry): void;
  warn(entry: MulticallLogEntry): void;
}

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
  /**
   * Per-request timeout in milliseconds for undici requests. When it fires,
   * the request is aborted and its pooled connection is destroyed, so a dead
   * socket cannot wedge the caller or poison the pool. Default: 30000.
   */
  undiciTimeoutMs?: number;
  /**
   * Enable timing logs for multicall flow phases.
   * Default: false
   */
  enableTimingLogs?: boolean;
  /**
   * Custom logger function for timing logs. Defaults to `logger.debug` with a
   * [multicall-timing] prefix, or console.log when no `logger` is set.
   */
  timingLogger?: TimingLogger;
  /**
   * Where the per-request RPC lines (debug) and fast-decode failures (warn)
   * go. Default: per-request lines are dropped, `enableTimingLogs` output goes
   * to console.log and warnings go to console.warn.
   */
  logger?: MulticallLogger;
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
