// fastDecodeStaticOutputs against the path it replaces: defaultAbiCoder.decode
// + Multicall's formatReturnValues. Runs against the CommonJS build:
// `npm run build:cjs` first.
const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const { ethers } = require('ethers');

const { Multicall } = require('../dist/cjs');
const { fastDecodeStaticOutputs } = require('../dist/cjs/fast-static-decode');

const reference = new Multicall({ nodeUrl: 'http://127.0.0.1:1', tryAggregate: true });
const fullDecode = (outputs, data) =>
  reference.formatReturnValues(ethers.utils.defaultAbiCoder.decode(outputs, data));

// Output lists as Interface.functions[...].outputs hands them over (ParamTypes),
// plus raw-ABI shapes (the manual-search fallback): aliases, empty and
// duplicate names, names ethers renames or skips.
const outputLists = [
  'function getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function slot0() returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function fee() returns (uint24)',
  'function tickSpacing() returns (int24)',
  'function wide() returns (int48 a, int56 b, uint48 c, uint56 d, int256 e)',
  'function bytesy() returns (bytes4 a, bytes20 b, bytes32 c, address d)',
].map((signature) => {
  const iface = new ethers.utils.Interface([signature]);
  return [signature, Object.values(iface.functions)[0].outputs];
});
outputLists.push(
  ['raw aliases and unnamed', [{ name: '', type: 'uint' }, { name: '', type: 'int' }, { type: 'address' }]],
  ['raw duplicate names', [{ name: 'x', type: 'uint8' }, { name: 'x', type: 'uint8' }, { name: 'y', type: 'bool' }]],
  ['raw renamed and skipped names', [{ name: 'length', type: 'uint256' }, { name: 'map', type: 'uint8' }, { name: 'ok', type: 'bool' }]],
);

// Deterministic so a failure reproduces.
let seed = 4242;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};
const randomWord = () => Array.from({ length: 64 }, () => Math.floor(rand() * 16).toString(16)).join('');
const edgeWords = [
  '0'.repeat(64),
  'f'.repeat(64),
  '0'.repeat(58) + '800000',
  '0'.repeat(58) + '7fffff',
  '0'.repeat(52) + '800000000000',
  '0'.repeat(24) + 'AbCd'.repeat(10),
  '8' + '0'.repeat(63),
];
const isAddress = (output) => output.type === 'address';
const dataFor = (outputs, pick) =>
  '0x' + outputs.map((o, i) => (isAddress(o) ? '0'.repeat(24) + pick(i).slice(24) : pick(i))).join('');

// Arrays compare by index and by own named key, with value types.
const snapshot = (values) => ({
  keys: Object.keys(values),
  entries: Object.keys(values).map((k) => [k, typeof values[k], values[k]]),
});

describe('fastDecodeStaticOutputs', () => {
  for (const [label, outputs] of outputLists) {
    it(`matches the full decoder: ${label}`, () => {
      const samples = [
        ...edgeWords.map((w) => dataFor(outputs, () => w)),
        ...Array.from({ length: 300 }, () => dataFor(outputs, randomWord)),
      ];
      for (const data of samples) {
        const fast = fastDecodeStaticOutputs(data, outputs);
        assert.notEqual(fast, null, data);
        assert.deepEqual(snapshot(fast), snapshot(fullDecode(outputs, data)), data);
      }
    });
  }

  it('defers on dynamic, tuple and array outputs', () => {
    const iface = new ethers.utils.Interface([
      'function a() returns (string)',
      'function b() returns ((uint256 x, address y) s)',
      'function c() returns (uint256[] v)',
      'function d() returns (uint256 x, bytes y)',
    ]);
    for (const fragment of Object.values(iface.functions)) {
      const data = '0x' + '0'.repeat(64 * 4);
      assert.equal(fastDecodeStaticOutputs(data, fragment.outputs), null, fragment.name);
    }
  });

  it('defers on a non-canonical length, non-hex data, or a dirty address word', () => {
    const [, reserves] = outputLists[0];
    const good = dataFor(reserves, () => '0'.repeat(63) + '1');
    assert.notEqual(fastDecodeStaticOutputs(good, reserves), null);
    assert.equal(fastDecodeStaticOutputs(good + '00'.repeat(32), reserves), null);
    assert.equal(fastDecodeStaticOutputs(good.slice(0, -64), reserves), null);
    assert.equal(fastDecodeStaticOutputs('0x' + 'zz' + good.slice(4), reserves), null);
    assert.equal(fastDecodeStaticOutputs('0x', reserves), null);
    const addressOut = [{ name: '', type: 'address' }, { name: '', type: 'uint8' }];
    assert.equal(fastDecodeStaticOutputs('0x' + 'f'.repeat(64) + '0'.repeat(64), addressOut), null);
    const numericName = [{ name: '7', type: 'uint8' }, { name: 'ok', type: 'bool' }];
    assert.equal(fastDecodeStaticOutputs('0x' + '0'.repeat(128), numericName), null);
  });
});

describe('Multicall result decoding through the static fast path', () => {
  const PAIR_ABI = [
    {
      name: 'getReserves',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: 'reserve0', type: 'uint112' },
        { name: 'reserve1', type: 'uint112' },
        { name: 'blockTimestampLast', type: 'uint32' },
      ],
    },
  ];
  const pair = new ethers.utils.Interface(PAIR_ABI);
  const multicallIface = new ethers.utils.Interface([
    'function tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes32 blockHash, (bool success, bytes returnData)[] returnData)',
  ]);
  const returnData = pair.encodeFunctionResult('getReserves', [10n ** 30n, 7, 1700000000]);
  let server;
  let url;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        const [, calls] = multicallIface.decodeFunctionData('tryBlockAndAggregate', payload.params[0].data);
        const result = multicallIface.encodeFunctionResult('tryBlockAndAggregate', [
          1,
          ethers.constants.HashZero,
          calls.map(() => [true, returnData]),
        ]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('returns what the full decoder would, named fields included', async () => {
    const multicall = new Multicall({
      nodeUrl: url,
      useUndici: true,
      tryAggregate: true,
      networkId: 56,
      multicallCustomContractAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
    });
    try {
      const { results } = await multicall.call({
        reference: 'pair',
        contractAddress: '0x' + 'ab'.repeat(20),
        abi: PAIR_ABI,
        calls: [{ reference: 'r', methodName: 'getReserves', methodParameters: [] }],
      });
      const [ctx] = results.pair.callsReturnContext;
      assert.equal(ctx.decoded, true);
      assert.deepEqual(
        snapshot(ctx.returnValues),
        snapshot(fullDecode(pair.functions['getReserves()'].outputs, returnData))
      );
      assert.equal(ctx.returnValues.reserve0, (10n ** 30n).toString());
      assert.equal(ctx.returnValues.blockTimestampLast, 1700000000);
    } finally {
      await multicall.close();
    }
  });
});
