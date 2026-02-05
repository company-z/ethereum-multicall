import { BigNumber, ethers } from 'ethers';
import { defaultAbiCoder } from 'ethers/lib/utils';
import { LRUCache } from 'lru-cache';
import { fetch, Pool } from 'undici';
import { ExecutionType, Networks } from './enums';
import {
  AbiItem,
  AbiOutput,
  AggregateCallContext,
  AggregateContractResponse,
  AggregateResponse,
  ContractCallContext,
  ContractCallResults,
  ContractCallReturnContext,
  MulticallOptionsCustomJsonRpcProvider,
  MulticallOptionsEthers,
  MulticallOptionsWeb3,
  ContractCallOptions,
} from './models';

export class Multicall {
  private readonly ABI = [
    {
      constant: false,
      inputs: [
        {
          components: [
            { name: 'target', type: 'address' },
            { name: 'callData', type: 'bytes' },
          ],
          name: 'calls',
          type: 'tuple[]',
        },
      ],
      name: 'aggregate',
      outputs: [
        { name: 'blockNumber', type: 'uint256' },
        { name: 'returnData', type: 'bytes[]' },
      ],
      payable: false,
      stateMutability: 'nonpayable',
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'bool',
          name: 'requireSuccess',
          type: 'bool',
        },
        {
          components: [
            {
              internalType: 'address',
              name: 'target',
              type: 'address',
            },
            {
              internalType: 'bytes',
              name: 'callData',
              type: 'bytes',
            },
          ],
          internalType: 'struct Multicall2.Call[]',
          name: 'calls',
          type: 'tuple[]',
        },
      ],
      name: 'tryBlockAndAggregate',
      outputs: [
        {
          internalType: 'uint256',
          name: 'blockNumber',
          type: 'uint256',
        },
        {
          internalType: 'bytes32',
          name: 'blockHash',
          type: 'bytes32',
        },
        {
          components: [
            {
              internalType: 'bool',
              name: 'success',
              type: 'bool',
            },
            {
              internalType: 'bytes',
              name: 'returnData',
              type: 'bytes',
            },
          ],
          internalType: 'struct Multicall2.Result[]',
          name: 'returnData',
          type: 'tuple[]',
        },
      ],
      stateMutability: 'nonpayable',
      type: 'function',
    },
  ];

  private _executionType: ExecutionType;
  private _cachedProvider?: ethers.providers.Provider;
  private _cachedNetworkId?: number;
  private _httpPool?: Pool;
  private _multicallInterface?: ethers.utils.Interface;
  // Cache for ABI interfaces to avoid recreating them for each call
  private _abiInterfaceCache = new LRUCache<string, ethers.utils.Interface>({ max: 1000 });
  // Cache for output types to avoid repeated ABI lookups (wrapped to allow undefined)
  private _outputTypesCache = new LRUCache<string, { outputs: AbiOutput[] | undefined }>({ max: 5000 });

  constructor(
    private _options:
      | MulticallOptionsWeb3
      | MulticallOptionsEthers
      | MulticallOptionsCustomJsonRpcProvider
  ) {
    if ((this._options as MulticallOptionsWeb3).web3Instance) {
      this._executionType = ExecutionType.web3;
      return;
    }

    if ((this._options as MulticallOptionsEthers).ethersProvider) {
      this._executionType = ExecutionType.ethers;
      return;
    }

    if ((this._options as MulticallOptionsCustomJsonRpcProvider).nodeUrl) {
      this._executionType = ExecutionType.customHttp;
      
      // Initialize undici pool for high-performance HTTP if enabled
      if (this._options.useUndici) {
        const nodeUrl = (this._options as MulticallOptionsCustomJsonRpcProvider).nodeUrl;
        const url = new URL(nodeUrl);
        this._httpPool = new Pool(url.origin, {
          connections: 100,
          pipelining: 1,
          keepAliveTimeout: 30000,
          keepAliveMaxTimeout: 60000,
          allowH2: true
        });
      }
      return;
    }

    throw new Error(
      // tslint:disable-next-line: max-line-length
      'Your options passed in our incorrect they need to match either `MulticallOptionsEthers`, `MulticallOptionsWeb3` or `MulticallOptionsCustomJsonRpcProvider` interfaces'
    );
  }
  
  /**
   * Close the HTTP pool connection (call when done with multicall instance)
   */
  public async close(): Promise<void> {
    if (this._httpPool) {
      await this._httpPool.close();
      this._httpPool = undefined;
    }
  }
  
  /**
   * Get or create the multicall interface for encoding/decoding
   */
  private getMulticallInterface(): ethers.utils.Interface {
    if (!this._multicallInterface) {
      this._multicallInterface = new ethers.utils.Interface(this.ABI);
    }
    return this._multicallInterface;
  }
  
  /**
   * Call all the contract calls in 1
   * @param calls The calls
   */
  public async call(
    contractCallContexts: ContractCallContext[] | ContractCallContext,
    contractCallOptions: ContractCallOptions = {}
  ): Promise<ContractCallResults> {
    if (!Array.isArray(contractCallContexts)) {
      contractCallContexts = [contractCallContexts];
    }

    const aggregateResponse = await this.execute(
      this.buildAggregateCallContext(contractCallContexts),
      contractCallOptions
    );

    const returnObject: ContractCallResults = {
      results: {},
      blockNumber: aggregateResponse.blockNumber,
    };

    for (
      let response = 0;
      response < aggregateResponse.results.length;
      response++
    ) {
      const contractCallsResults = aggregateResponse.results[response];
      const originalContractCallContext =
        contractCallContexts[contractCallsResults.contractContextIndex];

      // Store reference to original context - avoid expensive deep clone of ABI
      // Consumers should treat this as read-only
      // Pre-allocate callsReturnContext array with correct size to place results by index
      // This ensures callsReturnContext[idx] corresponds to calls[idx] even when batches
      // are split/merged or return out of order
      const returnObjectResult: ContractCallReturnContext = {
        originalContractCallContext: originalContractCallContext,
        callsReturnContext: new Array(originalContractCallContext.calls.length),
      };

      for (
        let method = 0;
        method < contractCallsResults.methodResults.length;
        method++
      ) {
        const methodContext = contractCallsResults.methodResults[method];
        const callIndex = methodContext.contractMethodIndex;
        const originalContractCallMethodContext =
          originalContractCallContext.calls[callIndex];

        const outputTypes = this.findOutputTypesFromAbi(
          originalContractCallContext.abi,
          originalContractCallMethodContext.methodName
        );

        if (this._options.tryAggregate && !methodContext.result.success) {
          // Place result at the correct index (not push) to maintain correspondence with calls array
          returnObjectResult.callsReturnContext[callIndex] = {
            returnValues: [methodContext.result.returnData],
            decoded: false,
            reference: originalContractCallMethodContext.reference,
            methodName: originalContractCallMethodContext.methodName,
            methodParameters: originalContractCallMethodContext.methodParameters,
            success: false,
          };
          continue;
        }

        if (outputTypes && outputTypes.length > 0) {
          try {
            // getReturnDataFromResult returns hex bytes string (typed as any[] but actually string)
            const returnData = this.getReturnDataFromResult(methodContext.result) as unknown as string;
            
            // Try fast path for simple types first (avoids expensive ABI decoder)
            let decodedReturnValues: any[] | null = this.fastDecodeSimpleType(returnData, outputTypes);
            
            if (!decodedReturnValues) {
              // Fall back to full ABI decoder for complex types
              const decoded = defaultAbiCoder.decode(
                // tslint:disable-next-line: no-any
                outputTypes as any,
                returnData
              );
              decodedReturnValues = this.formatReturnValues(decoded);
            }

            // Place result at the correct index (not push) to maintain correspondence with calls array
            returnObjectResult.callsReturnContext[callIndex] = {
              returnValues: decodedReturnValues,
              decoded: true,
              reference: originalContractCallMethodContext.reference,
              methodName: originalContractCallMethodContext.methodName,
              methodParameters: originalContractCallMethodContext.methodParameters,
              success: true,
            };
          } catch (e) {
            if (!this._options.tryAggregate) {
              throw e;
            }
            // Place result at the correct index (not push) to maintain correspondence with calls array
            returnObjectResult.callsReturnContext[callIndex] = {
              returnValues: [],
              decoded: false,
              reference: originalContractCallMethodContext.reference,
              methodName: originalContractCallMethodContext.methodName,
              methodParameters: originalContractCallMethodContext.methodParameters,
              success: false,
            };
          }
        } else {
          // Place result at the correct index (not push) to maintain correspondence with calls array
          returnObjectResult.callsReturnContext[callIndex] = {
            returnValues: this.getReturnDataFromResult(methodContext.result),
            decoded: false,
            reference: originalContractCallMethodContext.reference,
            methodName: originalContractCallMethodContext.methodName,
            methodParameters: originalContractCallMethodContext.methodParameters,
            success: true,
          };
        }
      }

      returnObject.results[
        returnObjectResult.originalContractCallContext.reference
      ] = returnObjectResult;
    }

    return returnObject;
  }

  /**
   * Get return data from result
   * @param result The result
   */
  // tslint:disable-next-line: no-any
  private getReturnDataFromResult(result: any): any[] {
    if (this._options.tryAggregate) {
      return result.returnData;
    }

    return result;
  }

  /**
   * Format return values so its always an array
   * Converts BigNumber to decimal strings for consistency with fast path
   * @param decodedReturnValues The decoded return values
   */
  // tslint:disable-next-line: no-any
  private formatReturnValues(decodedReturnValues: any): any[] {
    let decodedReturnResults = decodedReturnValues;
    if (decodedReturnValues.length === 1) {
      decodedReturnResults = decodedReturnValues[0];
    }

    if (Array.isArray(decodedReturnResults)) {
      return decodedReturnResults.map((val: any) => this.normalizeValue(val));
    }

    return [this.normalizeValue(decodedReturnResults)];
  }
  
  /**
   * Normalize a decoded value to match fast path return types
   * Converts BigNumber to decimal string, leaves other types unchanged
   * @param value The value to normalize
   */
  // tslint:disable-next-line: no-any
  private normalizeValue(value: any): any {
    // Convert BigNumber to decimal string
    if (BigNumber.isBigNumber(value)) {
      return value.toString();
    }
    
    // Recursively handle arrays (for tuple returns)
    if (Array.isArray(value)) {
      return value.map((v: any) => this.normalizeValue(v));
    }
    
    // Leave other types unchanged (string, boolean, bytes)
    return value;
  }

  /**
   * Build aggregate call context
   * @param contractCallContexts The contract call contexts
   */
  private buildAggregateCallContext(
    contractCallContexts: ContractCallContext[]
  ): AggregateCallContext[] {
    const aggregateCallContext: AggregateCallContext[] = [];

    for (let contract = 0; contract < contractCallContexts.length; contract++) {
      const contractContext = contractCallContexts[contract];
      
      // Cache interface creation - key includes full function signatures to avoid collisions
      const abiKey = contractContext.abi.length > 0 
        ? contractContext.abi.map(item => {
            const inputs = item.inputs?.map((i: { type: string }) => i.type).join(',') ?? '';
            return `${item.name}(${inputs})`;
          }).join('|')
        : 'empty';
      let executingInterface = this._abiInterfaceCache.get(abiKey);
      if (!executingInterface) {
        executingInterface = new ethers.utils.Interface(contractContext.abi as any);
        this._abiInterfaceCache.set(abiKey, executingInterface);
      }

      for (let method = 0; method < contractContext.calls.length; method++) {
        // https://github.com/ethers-io/ethers.js/issues/211
        const methodContext = contractContext.calls[method];
        // tslint:disable-next-line: no-unused-expression
        const encodedData = executingInterface.encodeFunctionData(
          methodContext.methodName,
          methodContext.methodParameters
        );

        aggregateCallContext.push({
          contractContextIndex: contract,  // No need to clone primitives
          contractMethodIndex: method,      // No need to clone primitives
          target: contractContext.contractAddress,
          encodedData,
        });
      }
    }

    return aggregateCallContext;
  }

  /**
   * Fast decode for simple/common return types without full ABI decoder overhead.
   * Returns null if the type is not supported for fast decoding.
   * @param returnData The raw hex return data
   * @param outputTypes The ABI output types
   */
  private fastDecodeSimpleType(
    returnData: string,
    outputTypes: AbiOutput[]
  ): any[] | null {
    // Only handle single output cases for now
    if (outputTypes.length !== 1) return null;
    
    const type = outputTypes[0].type;
    
    // uint256/uint128/etc - most common case for balance calls
    // Returns decimal string for maximum performance (avoids BigNumber overhead)
    if (type === 'uint256' || type === 'uint128' || type === 'uint64' || 
        type === 'uint32' || type === 'uint16' || type === 'uint8') {
      try {
        return [BigInt(returnData).toString(10)];
      } catch {
        return null; // Fall back to full decoder on error
      }
    }
    
    // int256/int128/etc - signed integers
    // Returns decimal string for maximum performance (avoids BigNumber overhead)
    if (type === 'int256' || type === 'int128' || type === 'int64' ||
        type === 'int32' || type === 'int16' || type === 'int8') {
      try {
        // Sign bit threshold and max value for each type
        const signedBitInfo: Record<string, { signBit: bigint; maxVal: bigint }> = {
          'int256': { signBit: 1n << 255n, maxVal: 1n << 256n },
          'int128': { signBit: 1n << 127n, maxVal: 1n << 128n },
          'int64':  { signBit: 1n << 63n,  maxVal: 1n << 64n },
          'int32':  { signBit: 1n << 31n,  maxVal: 1n << 32n },
          'int16':  { signBit: 1n << 15n,  maxVal: 1n << 16n },
          'int8':   { signBit: 1n << 7n,   maxVal: 1n << 8n },
        };
        
        const bn = BigInt(returnData);
        const { signBit, maxVal } = signedBitInfo[type];
        
        // Mask to the correct bit width, then check sign bit
        const masked = bn & (maxVal - 1n);
        if (masked >= signBit) {
          // Negative number in two's complement
          return [(masked - maxVal).toString(10)];
        }
        return [masked.toString(10)];
      } catch {
        return null;
      }
    }
    
    // address type
    if (type === 'address') {
      try {
        // Extract last 40 chars (20 bytes) and checksum to match ABI decoder
        const addr = ethers.utils.getAddress('0x' + returnData.slice(-40));
        return [addr];
      } catch {
        return null;
      }
    }
    
    // bool type
    if (type === 'bool') {
      try {
        // Any non-zero value is true
        return [returnData !== '0x' + '0'.repeat(64)];
      } catch {
        return null;
      }
    }
    
    // bytes32 type
    if (type === 'bytes32') {
      // Return as-is (already 32 bytes hex)
      return [returnData];
    }
    
    return null; // Fall back to full decoder for other types
  }

  /**
   * Find output types from abi (with caching for performance)
   * @param abi The abi
   * @param methodName The method name
   */
  private findOutputTypesFromAbi(
    abi: AbiItem[],
    methodName: string
  ): AbiOutput[] | undefined {
    methodName = methodName.trim();
    
    // Create a cache key from full function signatures to avoid collisions
    const abiKey = abi.length > 0 
      ? abi.map(item => {
          const inputs = item.inputs?.map((i: { type: string }) => i.type).join(',') ?? '';
          return `${item.name}(${inputs})`;
        }).join('|')
      : 'empty';
    const cacheKey = `${abiKey}:${methodName}`;
    
    // Check output types cache first
    if (this._outputTypesCache.has(cacheKey)) {
      return this._outputTypesCache.get(cacheKey)!.outputs;
    }
    
    // Get or create cached interface for this ABI
    let iface = this._abiInterfaceCache.get(abiKey);
    if (!iface) {
      try {
        iface = new ethers.utils.Interface(abi as any);
        this._abiInterfaceCache.set(abiKey, iface);
      } catch {
        // If interface creation fails, fall back to manual search
        iface = undefined;
      }
    }
    
    let outputs: AbiOutput[] | undefined;
    
    // Try to get outputs from interface
    if (iface?.functions[methodName]) {
      outputs = iface.functions[methodName].outputs;
    } else {
      // Fall back to manual ABI search
      for (let i = 0; i < abi.length; i++) {
        if (abi[i].name?.trim() === methodName) {
          outputs = abi[i].outputs;
          break;
        }
      }
    }
    
    // Cache the result
    this._outputTypesCache.set(cacheKey, { outputs });
    return outputs;
  }

  /**
   * Execute the multicall contract call
   * @param calls The calls
   */
  private async execute(
    calls: AggregateCallContext[],
    options: ContractCallOptions
  ): Promise<AggregateResponse> {
    // Split calls into batches if batchSize is configured
    const batchSize = this._options.batchSize;
    if (batchSize && batchSize > 0 && calls.length > batchSize) {
      return await this.executeInBatches(calls, options, batchSize);
    }
    
    return await this.executeSingleBatch(calls, options);
  }
  
  /**
   * Execute calls in parallel batches
   * @param calls The calls
   * @param options Call options
   * @param batchSize Max calls per batch
   */
  private async executeInBatches(
    calls: AggregateCallContext[],
    options: ContractCallOptions,
    batchSize: number
  ): Promise<AggregateResponse> {
    const batches: AggregateCallContext[][] = [];
    for (let i = 0; i < calls.length; i += batchSize) {
      batches.push(calls.slice(i, i + batchSize));
    }
    
    const results = await Promise.all(
      batches.map(batch => this.executeSingleBatch(batch, options))
    );
    
    return this.mergeAggregateResponses(results);
  }
  
  /**
   * Merge multiple aggregate responses into one
   * @param responses The responses to merge
   */
  private mergeAggregateResponses(
    responses: AggregateResponse[]
  ): AggregateResponse {
    if (responses.length === 0) {
      throw new Error('No responses to merge');
    }
    
    const merged: AggregateResponse = {
      blockNumber: responses[0].blockNumber,
      results: [],
    };
    
    // Use a Map for efficient merging
    const resultMap = new Map<number, AggregateResponse['results'][0]>();
    
    for (const response of responses) {
      for (const result of response.results) {
        const existing = resultMap.get(result.contractContextIndex);
        if (existing) {
          existing.methodResults.push(...result.methodResults);
        } else {
          resultMap.set(result.contractContextIndex, {
            contractContextIndex: result.contractContextIndex,
            methodResults: [...result.methodResults],
          });
        }
      }
    }
    
    merged.results = Array.from(resultMap.values());
    return merged;
  }
  
  /**
   * Execute a single batch of calls
   * @param calls The calls
   * @param options Call options
   */
  private async executeSingleBatch(
    calls: AggregateCallContext[],
    options: ContractCallOptions
  ): Promise<AggregateResponse> {
    switch (this._executionType) {
      case ExecutionType.web3:
        return await this.executeWithWeb3(calls, options);
      case ExecutionType.ethers:
        return await this.executeWithEthersOrCustom(calls, options);
      case ExecutionType.customHttp:
        // Use undici if enabled, otherwise fall back to ethers
        if (this._options.useUndici && this._httpPool) {
          return await this.executeWithUndici(calls, options);
        }
        return await this.executeWithEthersOrCustom(calls, options);
      default:
        throw new Error(`${this._executionType} is not defined`);
    }
  }

  /**
   * Execute aggregate with web3 instance
   * @param calls The calls context
   */
  private async executeWithWeb3(
    calls: AggregateCallContext[],
    options: ContractCallOptions
  ): Promise<AggregateResponse> {
    const web3 = this.getTypedOptions<MulticallOptionsWeb3>().web3Instance;
    
    // Cache network ID for subsequent calls
    if (!this._cachedNetworkId && !this._options.networkId) {
      this._cachedNetworkId = await web3.eth.net.getId();
    }
    const networkId = this._options.networkId || this._cachedNetworkId!;
    const contract = new web3.eth.Contract(
      this.ABI,
      this.getContractBasedOnNetwork(networkId)
    );
    const callParams = [];
    if (options.blockNumber) {
      callParams.push(options.blockNumber);
    }
    if (this._options.tryAggregate) {
      const contractResponse = (await contract.methods
        .tryBlockAndAggregate(
          false,
          this.mapCallContextToMatchContractFormat(calls)
        )
        .call(...callParams)) as AggregateContractResponse;

      contractResponse.blockNumber = BigNumber.from(
        contractResponse.blockNumber
      );

      return this.buildUpAggregateResponse(contractResponse, calls);
    } else {
      const contractResponse = (await contract.methods
        .aggregate(this.mapCallContextToMatchContractFormat(calls))
        .call(...callParams)) as AggregateContractResponse;

      contractResponse.blockNumber = BigNumber.from(
        contractResponse.blockNumber
      );

      return this.buildUpAggregateResponse(contractResponse, calls);
    }
  }

  /**
   * Execute with ethers using passed in provider context or custom one
   * @param calls The calls
   */
  private async executeWithEthersOrCustom(
    calls: AggregateCallContext[],
    options: ContractCallOptions
  ): Promise<AggregateResponse> {
    // Use cached provider for better performance
    const ethersProvider = await this.getCachedProvider();
    
    // Use cached network ID
    const network = await this.getCachedNetworkId();

    const contract = new ethers.Contract(
      this.getContractBasedOnNetwork(network),
      this.ABI,
      ethersProvider
    );
    let overrideOptions = {};
    if (options.blockNumber) {
      overrideOptions = {
        ...overrideOptions,
        blockTag: Number(options.blockNumber),
      };
    }
    if (this._options.tryAggregate) {
      const contractResponse = (await contract.callStatic.tryBlockAndAggregate(
        false,
        this.mapCallContextToMatchContractFormat(calls),
        overrideOptions
      )) as AggregateContractResponse;

      return this.buildUpAggregateResponse(contractResponse, calls);
    } else {
      const contractResponse = (await contract.callStatic.aggregate(
        this.mapCallContextToMatchContractFormat(calls),
        overrideOptions
      )) as AggregateContractResponse;

      return this.buildUpAggregateResponse(contractResponse, calls);
    }
  }
  
  /**
   * Execute with undici fetch for high-performance HTTP with auto-decompression
   * @param calls The calls
   * @param options Call options
   */
  private async executeWithUndici(
    calls: AggregateCallContext[],
    options: ContractCallOptions
  ): Promise<AggregateResponse> {
    const customProvider = this.getTypedOptions<MulticallOptionsCustomJsonRpcProvider>();
    
    // Get cached network ID or fetch it
    const networkId = await this.getCachedNetworkId();
    const multicallAddress = this.getContractBasedOnNetwork(networkId);
    
    // Encode the call data
    const multicallInterface = this.getMulticallInterface();
    const mappedCalls = this.mapCallContextToMatchContractFormat(calls);
    const callData = this._options.tryAggregate
      ? multicallInterface.encodeFunctionData('tryBlockAndAggregate', [false, mappedCalls])
      : multicallInterface.encodeFunctionData('aggregate', [mappedCalls]);
    
    // Build the JSON-RPC request
    const blockTag = options.blockNumber 
      ? `0x${Number(options.blockNumber).toString(16)}` 
      : 'latest';
    
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [
        { to: multicallAddress, data: callData },
        blockTag,
      ],
    };
    
    // Make the request using undici fetch with pool dispatcher (auto-decompression)
    const startTime = Date.now();
    const response = await fetch(customProvider.nodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(payload),
      dispatcher: this._httpPool,
    });
    const fetchDuration = Date.now() - startTime;
    
    const contentEncoding = response.headers.get('content-encoding') ?? 'none';
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    // Parse the response (fetch auto-decompresses gzip)
    const jsonStartTime = Date.now();
    const responseData = await response.json() as {
      result?: string;
      error?: { message: string; code: number };
    };
    const jsonDuration = Date.now() - jsonStartTime;
    
    console.log(
      `[multicall] calls=${calls.length} block=${blockTag} compression=${contentEncoding} fetch=${fetchDuration}ms json=${jsonDuration}ms url=${customProvider.nodeUrl}`
    );
    
    if (responseData.error) {
      throw new Error(`RPC Error: ${responseData.error.message} (code: ${responseData.error.code})`);
    }
    
    if (!responseData.result) {
      throw new Error('RPC returned empty result');
    }
    
    // Decode the response
    const methodName = this._options.tryAggregate ? 'tryBlockAndAggregate' : 'aggregate';
    const decoded = multicallInterface.decodeFunctionResult(methodName, responseData.result);
    
    const contractResponse: AggregateContractResponse = {
      blockNumber: BigNumber.from(decoded.blockNumber),
      returnData: decoded.returnData,
    };
    
    return this.buildUpAggregateResponse(contractResponse, calls);
  }
  
  /**
   * Get cached network ID or fetch and cache it
   */
  private async getCachedNetworkId(): Promise<number> {
    if (this._options.networkId) {
      return this._options.networkId;
    }
    
    if (this._cachedNetworkId) {
      return this._cachedNetworkId;
    }
    
    // For undici path, we need to fetch network ID via JSON-RPC
    if (this._options.useUndici && this._httpPool) {
      const customProvider = this.getTypedOptions<MulticallOptionsCustomJsonRpcProvider>();
      
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      };
      
      // Use fetch with pool dispatcher (auto-decompression)
      const startTime = Date.now();
      const response = await fetch(customProvider.nodeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(payload),
        dispatcher: this._httpPool,
      });
      const fetchDuration = Date.now() - startTime;
      
      const contentEncoding = response.headers.get('content-encoding') ?? 'none';
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const jsonStartTime = Date.now();
      const responseData = await response.json() as { result: string };
      const jsonDuration = Date.now() - jsonStartTime;
      
      this._cachedNetworkId = parseInt(responseData.result, 16);
      
      console.log(
        `[eth_chainId] networkId=${this._cachedNetworkId} compression=${contentEncoding} fetch=${fetchDuration}ms json=${jsonDuration}ms url=${customProvider.nodeUrl}`
      );
      
      return this._cachedNetworkId;
    }
    
    // Fall back to ethers provider for network ID
    const provider = await this.getCachedProvider();
    const network = await provider.getNetwork();
    this._cachedNetworkId = network.chainId;
    return this._cachedNetworkId;
  }
  
  /**
   * Get cached provider or create and cache one
   */
  private async getCachedProvider(): Promise<ethers.providers.Provider> {
    if (this._cachedProvider) {
      return this._cachedProvider;
    }
    
    let ethersProvider = this.getTypedOptions<MulticallOptionsEthers>().ethersProvider;
    
    if (!ethersProvider) {
      const customProvider = this.getTypedOptions<MulticallOptionsCustomJsonRpcProvider>();
      if (customProvider.nodeUrl) {
        ethersProvider = new ethers.providers.JsonRpcProvider(customProvider.nodeUrl);
      } else {
        ethersProvider = ethers.getDefaultProvider();
      }
    }
    
    this._cachedProvider = ethersProvider;
    return ethersProvider;
  }

  /**
   * Build up the aggregated response from the contract response mapping
   * metadata from the calls
   * @param contractResponse The contract response
   * @param calls The calls
   */
  private buildUpAggregateResponse(
    contractResponse: AggregateContractResponse,
    calls: AggregateCallContext[]
  ): AggregateResponse {
    // Use Map for O(1) lookups instead of O(n) .find() in loop
    const resultMap = new Map<number, AggregateResponse['results'][0]>();

    for (let i = 0; i < contractResponse.returnData.length; i++) {
      const contextIndex = calls[i].contractContextIndex;
      let existing = resultMap.get(contextIndex);
      
      if (!existing) {
        existing = {
          methodResults: [],
          contractContextIndex: contextIndex,
        };
        resultMap.set(contextIndex, existing);
      }
      
      existing.methodResults.push({
        result: contractResponse.returnData[i],
        contractMethodIndex: calls[i].contractMethodIndex,
      });
    }

    return {
      blockNumber: contractResponse.blockNumber.toNumber(),
      results: Array.from(resultMap.values()),
    };
  }

  /**
   * Map call contract to match contract format
   * @param calls The calls context
   */
  private mapCallContextToMatchContractFormat(
    calls: AggregateCallContext[]
  ): Array<{
    target: string;
    callData: string;
  }> {
    return calls.map((call) => {
      return {
        target: call.target,
        callData: call.encodedData,
      };
    });
  }

  /**
   * Get typed options
   */
  private getTypedOptions<T>(): T {
    return this._options as unknown as T;
  }

  /**
   * Get the contract based on the network
   * @param tryAggregate The tryAggregate
   * @param network The network
   */
  private getContractBasedOnNetwork(network: Networks): string {
    // if they have overriden the multicall custom contract address then use that
    if (this._options.multicallCustomContractAddress) {
      return this._options.multicallCustomContractAddress;
    }

    switch (network) {
      case Networks.mainnet:
      case Networks.kovan:
      case Networks.rinkeby:
      case Networks.ropsten:
      case Networks.goerli:
        return '0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696';
      case Networks.bsc:
        return '0xC50F4c1E81c873B2204D7eFf7069Ffec6Fbe136D';
      case Networks.bsc_testnet:
        return '0x73CCde5acdb9980f54BcCc0483B28B8b4a537b4A';
      case Networks.xdai:
        return '0x2325b72990D81892E0e09cdE5C80DD221F147F8B';
      case Networks.mumbai:
        return '0xe9939e7Ea7D7fb619Ac57f648Da7B1D425832631';
      case Networks.matic:
        return '0x275617327c958bD06b5D6b871E7f491D76113dd8';
      case Networks.etherlite:
        return '0x21681750D7ddCB8d1240eD47338dC984f94AF2aC';
      case Networks.arbitrum:
        return '0x80C7DD17B01855a6D2347444a0FCC36136a314de';
      case Networks.avalancheFuji:
        return '0x3D015943d2780fE97FE3f69C97edA2CCC094f78c';
      case Networks.avalancheMainnet:
        return '0xed386Fe855C1EFf2f843B910923Dd8846E45C5A4';
      case Networks.fantom:
        return '0xD98e3dBE5950Ca8Ce5a4b59630a5652110403E5c';
      case Networks.cronos:
        return '0x5e954f5972EC6BFc7dECd75779F10d848230345F';
      case Networks.harmony:
        return '0x5c41f6817feeb65d7b2178b0b9cebfc8fad97969';
      case Networks.optimism:
        return '0xeAa6877139d436Dc6d1f75F3aF15B74662617B2C';
      case Networks.kovanOptimism:
        return '0x91c88479F21203444D2B20Aa001f951EC8CF2F68';
      case Networks.aurora:
        return '0x04364F8908BDCB4cc7EA881d0DE869398BA849C9';
      case Networks.evmos:
        return '0x80ed034722D8e0D9aC1F39EF69c65dfbf9b8C558';
      case Networks.klaytn:
        return '0x2fe78f55c39dc437c4c025f8a1ffc54edb4a34c3';
      case Networks.aurora:
        return '0xBF69a56D35B8d6f5A8e0e96B245a72F735751e54';
      case Networks.boba:
        return '0xaeD5b25BE1c3163c907a471082640450F928DDFE';
      case Networks.celo:
        return '0x86aAD62D1C36f4f92C8219D5C3ff97c3EF471bb8';
      case Networks.elastos:
        return '0x5e1554B25731C98e58d5728847938db3DfFA1b57';
      case Networks.fuse:
        return '0x0769fd68dFb93167989C6f7254cd0D766Fb2841F';
      case Networks.heco:
        return '0xbB5d56bb107FfB849fF5577f692C2ee8E8c38607';
      case Networks.hsc:
        return '0x1d44a4fb4C02201bdB49FA9433555F2Ee46BC9B8';
      case Networks.iotex:
        return '0x4c1329a07f2525d428dc03374cd46b852a511fec';
      case Networks.kcc:
        return '0x0185Fe88dB541F2DB1F6a7343bd4CF17000d98D7';
      case Networks.metis:
        return '0xc39aBB6c4451089dE48Cffb013c39d3110530e5C';
      case Networks.moonbeam:
        return '0x6477204E12A7236b9619385ea453F370aD897bb2';
      case Networks.moonriver:
        return '0x43D002a2B468F048028Ea9C2D3eD4705a94e68Ae';
      case Networks.oasis:
        return '0x970F9F4d7D752423A82f4a790B7117D949939B0b';
      case Networks.velas:
        return '0x0747CFe82D3Bee998f634569FE2B0005dF9d8EDE';
      case Networks.wanchain:
        return '0x70bd16472b30B9B11362C4f5DB0F702099156aAA';
      case Networks.telos:
        return '0x89fcf2008981cc2cd9389f445f7f6e59ea69cbf0';
      case Networks.oec:
        return '0x89FCf2008981cC2Cd9389f445F7f6e59eA69cbF0';
      case Networks.smartbch:
        return '0x89FCf2008981cC2Cd9389f445F7f6e59eA69cbF0';
      case Networks.shiden:
        return '0x89FCf2008981cC2Cd9389f445F7f6e59eA69cbF0';
      case Networks.kardia:
        return '0xAF60776A49b273318FFE1fC424bc6817209384c1';
      case Networks.polis:
        return '0x89FCf2008981cC2Cd9389f445F7f6e59eA69cbF0';
      case Networks.astar:
        return '0x89BEcA8D00e721b7714e12F1c29A2523DBE798a7';
      case Networks.milkomeda:
        return '0x2ecBF8b054Ef234F3523D605E7ba9cfE9A37703a';
      case Networks.avalanchedfk:
        return '0x5b24224dC16508DAD755756639E420817DD4c99E';
      case Networks.conflux:
        return '0xbd6706747a7b6c8868cf48735f48c341ea386d07';
      case Networks.syscoin:
        return '0xbD6706747a7B6C8868Cf48735f48C341ea386d07';
      case Networks.echelon:
        return '0xb4495b21de57dfa6b12cc414525d1850b5fee52d';
      case Networks.energi:
        return '0xbd6706747a7b6c8868cf48735f48c341ea386d07';
      case Networks.energyweb:
        return '0xbd6706747a7b6c8868cf48735f48c341ea386d07';
      case Networks.zyx:
        return '0xbd6706747a7b6c8868cf48735f48c341ea386d07';
      case Networks.nova:
        return '0x2fe78f55c39dc437c4c025f8a1ffc54edb4a34c3';
      case Networks.canto:
        return '0x59bbf55e70a1afdb25e94fc5ad1d81aa51c3efab';
      case Networks.dogechain:
        return '0xe4a8ee19f38522bae0d8219b6cba22ed48ee25d7';
      case Networks.zksync:
        return '0x30f32f526caaedaa557290609c02163927a5d151';
      case Networks.pulsechain:
        return '0x54db8bdb0b72efa1133cc3b8195d22d5490611e3';
      case Networks.base:
        return '0x0434529f41584c72150a21d41eeddad6652343c4';
      case Networks.sepolia:
        return '0x7a37fcabacc6b04422f2a625080cef2d1b4b6e4e';
      case Networks.opbnb:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.polygonzkevm:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.mantle:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.core:
        return '0x024f0041b76b598c2a0a75004f8447faf67bd004';
      case Networks.linea:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.shibarium:
        return '0xdacb3e10aa06d544dc6d9be4b8411bcd493bc420';
      case Networks.blast:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.blastmainnet:
        return '0xca11bde05977b3631167028862be2a173976ca11';
      case Networks.berachain:
        return '0x9d1db8253105b007ddde65ce262f701814b91125';
      default:
        throw new Error(
          `Network - ${network} doesn't have a multicall contract address defined. Please check your network or deploy your own contract on it.`
        );
    }
  }
}
