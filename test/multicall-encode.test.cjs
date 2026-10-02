// End-to-end check of the undici path's request encoding against a local
// JSON-RPC stub. Runs against the CommonJS build: `npm run build:cjs` first.
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
const erc20 = new ethers.utils.Interface(ERC20_ABI);

describe('Multicall undici request encoding', () => {
  let server;
  let url;
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body);
        requests.push(payload);
        const [, calls] = multicallIface.decodeFunctionData(
          'tryBlockAndAggregate',
          payload.params[0].data
        );
        // Each call returns its index + 1 as the balance.
        const result = multicallIface.encodeFunctionResult('tryBlockAndAggregate', [
          123,
          ethers.constants.HashZero,
          calls.map((_, i) => [true, ethers.utils.defaultAbiCoder.encode(['uint256'], [i + 1])]),
        ]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('sends exactly the calldata ethers would encode, and repeats it from cache', async () => {
    const multicall = new Multicall({
      nodeUrl: url,
      useUndici: true,
      tryAggregate: true,
      networkId: 56,
      multicallCustomContractAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
    });
    const owners = [
      ethers.utils.getAddress('0x' + '11'.repeat(20)),
      '0x' + '22'.repeat(20),
    ];
    const contexts = [
      {
        reference: 'a',
        contractAddress: ethers.utils.getAddress('0x' + 'ab'.repeat(20)),
        abi: ERC20_ABI,
        calls: owners.map((o, i) => ({ reference: `a${i}`, methodName: 'balanceOf', methodParameters: [o] })),
      },
      {
        reference: 'b',
        contractAddress: '0x' + 'cd'.repeat(20),
        abi: ERC20_ABI,
        calls: [{ reference: 'b0', methodName: 'balanceOf', methodParameters: [owners[0]] }],
      },
    ];
    const expected = multicallIface.encodeFunctionData('tryBlockAndAggregate', [
      false,
      [
        [contexts[0].contractAddress, erc20.encodeFunctionData('balanceOf', [owners[0]])],
        [contexts[0].contractAddress, erc20.encodeFunctionData('balanceOf', [owners[1]])],
        [contexts[1].contractAddress, erc20.encodeFunctionData('balanceOf', [owners[0]])],
      ],
    ]);

    try {
      for (let round = 0; round < 2; round++) {
        const { results } = await multicall.call(contexts);
        assert.equal(requests.at(-1).params[0].data, expected);
        const values = [
          ...results.a.callsReturnContext.map((c) => c.returnValues[0]),
          ...results.b.callsReturnContext.map((c) => c.returnValues[0]),
        ].map((v) => (typeof v === 'string' ? v : ethers.BigNumber.from(v).toString()));
        assert.deepEqual(values, ['1', '2', '3']);
      }
      assert.equal(requests.length, 2);
    } finally {
      await multicall.close();
    }
  });
});
