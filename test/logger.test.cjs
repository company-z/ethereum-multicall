// Where the undici path's per-request lines go. Runs against the CommonJS
// build: `npm run build:cjs` first.
const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const { ethers } = require('ethers');

const { Multicall } = require('../dist/cjs');

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];
const multicallIface = new ethers.utils.Interface([
  'function tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, (bool success, bytes returnData)[] returnData)',
]);
const CONTEXTS = [
  {
    reference: 'a',
    contractAddress: '0x' + 'ab'.repeat(20),
    abi: ERC20_ABI,
    calls: [{ reference: 'a0', methodName: 'balanceOf', methodParameters: ['0x' + '11'.repeat(20)] }],
  },
];

const recorder = () => {
  const entries = { debug: [], warn: [] };
  return {
    entries,
    logger: { debug: (e) => entries.debug.push(e), warn: (e) => entries.warn.push(e) },
  };
};

describe('Multicall logger', () => {
  let server;
  let url;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (payload.method === 'eth_chainId') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: '0x38' }));
          return;
        }
        const [, calls] = multicallIface.decodeFunctionData('tryBlockAndAggregate', payload.params[0].data);
        const result = multicallIface.encodeFunctionResult('tryBlockAndAggregate', [
          123,
          ethers.constants.HashZero,
          calls.map(() => [true, ethers.utils.defaultAbiCoder.encode(['uint256'], [1])]),
        ]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // A keyed path, like Alchemy's /v2/<key>: only the host may be logged.
    url = `http://127.0.0.1:${server.address().port}/v2/SECRET-KEY`;
  });

  after(() => server.close());

  // console.log output while `fn` runs, each line parsed as JSON.
  const captureJsonLines = async (fn) => {
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args);
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines.map((args) => {
      assert.equal(args.length, 1, 'one JSON string per line');
      return JSON.parse(args[0]);
    });
  };

  const run = async (options, configure) => {
    const multicall = new Multicall({
      nodeUrl: url,
      useUndici: true,
      tryAggregate: true,
      networkId: 56,
      multicallCustomContractAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
      ...options,
    });
    configure?.(multicall);
    try {
      await multicall.call(CONTEXTS, { blockNumber: '100' });
    } finally {
      await multicall.close();
    }
  };

  it('still prints the request line by default, as JSON with values as fields', async () => {
    const lines = await captureJsonLines(() => run({}));
    const host = new URL(url).host;
    const requests = lines.filter((l) => l.message.startsWith('[multicall] calls='));
    assert.equal(requests.length, 1);
    const [line] = requests;
    assert.equal(line.level, 'debug');
    assert.match(line.message, new RegExp(`^\\[multicall\\] calls=1 block=0x64 compression=none fetch=\\d+ms json=\\d+ms host=${host}$`));
    assert.equal(line.calls, 1);
    assert.equal(line.blockTag, '0x64');
    assert.equal(line.host, host);
    assert.doesNotMatch(JSON.stringify(lines), /SECRET-KEY/);
  });

  it('still prints the eth_chainId line by default, as JSON', async () => {
    const lines = await captureJsonLines(() => run({ networkId: undefined }));
    const chainId = lines.filter((l) => l.message.startsWith('[eth_chainId] networkId=56 '));
    assert.equal(chainId.length, 1);
    assert.equal(chainId[0].level, 'debug');
    assert.equal(chainId[0].networkId, 56);
    assert.equal(chainId[0].host, new URL(url).host);
  });

  it('sends the request line to the logger at debug, values as fields, host only', async () => {
    const { entries, logger } = recorder();
    await run({ logger });
    assert.equal(entries.debug.length, 1);
    const [entry] = entries.debug;
    const host = new URL(url).host;
    assert.match(entry.message, new RegExp(`^\\[multicall\\] calls=1 block=0x64 compression=none fetch=\\d+ms json=\\d+ms host=${host}$`));
    assert.equal(entry.calls, 1);
    assert.equal(entry.blockTag, '0x64');
    assert.equal(entry.compression, 'none');
    assert.equal(entry.host, host);
    assert.equal(typeof entry.fetchDurationMs, 'number');
    assert.equal(typeof entry.jsonDurationMs, 'number');
    assert.doesNotMatch(JSON.stringify(entries), /SECRET-KEY/);
  });

  it('uses setDefaultLogger only when the options passed none', async () => {
    const fallback = recorder();
    await run({}, (m) => m.setDefaultLogger(fallback.logger));
    assert.equal(fallback.entries.debug.length, 1);

    const own = recorder();
    const ignored = recorder();
    await run({ logger: own.logger }, (m) => m.setDefaultLogger(ignored.logger));
    assert.equal(own.entries.debug.length, 1);
    assert.equal(ignored.entries.debug.length, 0);
  });

  it('keeps enableTimingLogs output on the console when no logger is passed', async () => {
    const lines = await captureJsonLines(() => run({ enableTimingLogs: true }));
    const timing = lines.filter((l) => l.message.startsWith('[multicall-timing] '));
    assert.ok(timing.length > 0);
    assert.equal(typeof timing[0].phase, 'string');
    assert.equal(typeof timing[0].durationMs, 'number');
    assert.ok(lines.some((l) => l.message.startsWith('[multicall] calls=')));
  });

  it('routes enableTimingLogs output to an injected logger instead of the console', async () => {
    const { entries, logger } = recorder();
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args);
    try {
      await run({ enableTimingLogs: true, logger });
    } finally {
      console.log = original;
    }
    assert.deepEqual(lines, []);
    assert.ok(entries.debug.some((e) => e.message.startsWith('[multicall-timing] ')));
  });
});
