import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { ethers } from 'ethers';

import { callDataCacheKey } from './call-data-cache-key.ts';
import {
  AGGREGATE_SELECTOR,
  encodeAggregateCallData,
  TRY_BLOCK_AND_AGGREGATE_SELECTOR,
} from './fast-aggregate-encode.ts';

const iface = new ethers.utils.Interface([
  'function aggregate((address target, bytes callData)[] calls)',
  'function tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls)',
]);

const ethersEncode = (
  calls: { target: string; callData: string }[],
  tryAggregate: boolean
): string =>
  tryAggregate
    ? iface.encodeFunctionData('tryBlockAndAggregate', [false, calls])
    : iface.encodeFunctionData('aggregate', [calls]);

const hex = (bytes: number): string => '0x' + randomBytes(bytes).toString('hex');

describe('encodeAggregateCallData', () => {
  it('uses the selectors ethers derives', () => {
    assert.equal(iface.getSighash('aggregate'), AGGREGATE_SELECTOR);
    assert.equal(
      iface.getSighash('tryBlockAndAggregate'),
      TRY_BLOCK_AND_AGGREGATE_SELECTOR
    );
  });

  for (const tryAggregate of [false, true]) {
    describe(tryAggregate ? 'tryBlockAndAggregate' : 'aggregate', () => {
      it('matches ethers byte for byte on a typical batch', () => {
        const calls = [
          // balanceOf(address): 4 + 32 bytes, not a multiple of 32
          { target: hex(20), callData: '0x70a08231' + '0'.repeat(24) + hex(20).slice(2) },
          // getReserves(): selector only
          { target: hex(20), callData: '0x0902f1ac' },
          // exactly 32 bytes and exactly 64 bytes (no padding needed)
          { target: hex(20), callData: hex(32) },
          { target: hex(20), callData: hex(64) },
          // empty calldata
          { target: hex(20), callData: '0x' },
        ];

        assert.equal(
          encodeAggregateCallData(calls, tryAggregate),
          ethersEncode(calls, tryAggregate)
        );
      });

      it('matches ethers on random batches', () => {
        for (let round = 0; round < 50; round++) {
          const calls = Array.from({ length: 1 + (round % 40) }, () => ({
            target: hex(20),
            callData: hex(Math.floor(Math.random() * 300)),
          }));
          assert.equal(
            encodeAggregateCallData(calls, tryAggregate),
            ethersEncode(calls, tryAggregate)
          );
        }
      });

      it('matches ethers on an empty batch', () => {
        assert.equal(
          encodeAggregateCallData([], tryAggregate),
          ethersEncode([], tryAggregate)
        );
      });

      it('lowercases upper-case hex the way ethers does', () => {
        const calls = [
          {
            target: '0x' + 'AB'.repeat(20),
            callData: '0x70A08231' + 'CD'.repeat(32),
          },
        ];
        assert.equal(
          encodeAggregateCallData(calls, tryAggregate),
          ethersEncode(calls, tryAggregate)
        );
      });
    });
  }

  it('encodes checksummed targets and matches ethers', () => {
    const calls = Array.from({ length: 5 }, () => ({
      target: ethers.utils.getAddress(hex(20)),
      callData: hex(36),
    }));
    assert.ok(calls.some((c) => /[A-F]/.test(c.target)));
    assert.equal(encodeAggregateCallData(calls, true), ethersEncode(calls, true));
  });

  it('defers a target with a wrong checksum so ethers raises its error', () => {
    const good = ethers.utils.getAddress('0x' + 'ab'.repeat(20));
    const flipped = good.slice(0, 2) + good.slice(2).replace(/[a-f]/, (c) => c.toUpperCase());
    assert.notEqual(flipped, good);
    assert.equal(encodeAggregateCallData([{ target: flipped, callData: '0x' }], false), undefined);
    assert.throws(() => ethersEncode([{ target: flipped, callData: '0x' }], false));
  });

  it('defers malformed input to ethers', () => {
    const target = hex(20);
    for (const call of [
      { target: target.slice(0, -2), callData: '0x' }, // 19-byte target
      { target: 'not-an-address', callData: '0x' },
      { target, callData: '0x123' }, // odd-length hex
      { target, callData: '0xzz' },
      { target, callData: '1234' }, // no prefix
    ]) {
      assert.equal(encodeAggregateCallData([call], false), undefined);
    }
  });
});

describe('callDataCacheKey', () => {
  it('keys primitive parameters and arrays of them', () => {
    assert.ok(callDataCacheKey('abi', 'balanceOf', ['0xabc']));
    assert.ok(callDataCacheKey('abi', 'getReserves', []));
    assert.ok(callDataCacheKey('abi', 'getReserves', undefined));
    assert.ok(callDataCacheKey('abi', 'f', [1, true, ['0x1', 2]]));
  });

  it('separates methods, ABIs and parameter types', () => {
    const keys = new Set([
      callDataCacheKey('abi', 'f', ['1']),
      callDataCacheKey('abi', 'f', [1]),
      callDataCacheKey('abi', 'g', ['1']),
      callDataCacheKey('abi2', 'f', ['1']),
      callDataCacheKey('abi', 'f', [['1']]),
    ]);
    assert.equal(keys.size, 5);
  });

  it('refuses parameters whose JSON is ambiguous or that are objects', () => {
    for (const params of [
      [ethers.BigNumber.from(1)],
      [1n],
      [null],
      [undefined],
      [{ a: 1 }],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [[null]],
    ]) {
      assert.equal(callDataCacheKey('abi', 'f', params as unknown[]), undefined);
    }
  });
});
