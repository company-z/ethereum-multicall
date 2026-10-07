// fastDecodeSimpleType against defaultAbiCoder.decode on return data that is not exactly one word.
// Runs against the CommonJS build: `npm run build:cjs` first.
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ethers } = require('ethers');

const { Multicall } = require('../dist/cjs');

const multicall = new Multicall({ nodeUrl: 'http://127.0.0.1:1', tryAggregate: true });
const fast = (type, data) => multicall.fastDecodeSimpleType(data, [{ type }]);
const word = (hex) => hex.padStart(64, '0');

// BSC TraitSniper.com's balanceOf for its PancakeSwap V3 pool, as Multicall3 returned it: the
// balance word followed by three zero words.
const BALANCE = '438432445506833849246620';
const PADDED_BALANCE = '0x' + word(BigInt(BALANCE).toString(16)) + '0'.repeat(64 * 3);

describe('fastDecodeSimpleType', () => {
  it('decodes a one-word uint256', () => {
    assert.deepEqual(fast('uint256', '0x' + word(BigInt(BALANCE).toString(16))), [BALANCE]);
  });

  it('leaves a padded return to the full decoder, which reads the first word', () => {
    assert.equal(fast('uint256', PADDED_BALANCE), null);
    assert.equal(
      ethers.utils.defaultAbiCoder.decode(['uint256'], PADDED_BALANCE)[0].toString(),
      BALANCE,
    );
  });

  for (const type of ['uint8', 'int256', 'address', 'bool', 'bytes32']) {
    it(`leaves a padded ${type} return to the full decoder`, () => {
      assert.equal(fast(type, '0x' + word('1') + word('0')), null);
    });

    it(`leaves a short ${type} return to the full decoder`, () => {
      assert.equal(fast(type, '0x' + '01'.repeat(16)), null);
    });
  }

  it('still decodes one-word values of every simple type', () => {
    assert.deepEqual(fast('uint8', '0x' + word('ff')), ['255']);
    assert.deepEqual(fast('int256', '0x' + 'f'.repeat(64)), ['-1']);
    assert.deepEqual(fast('bool', '0x' + word('1')), [true]);
    assert.deepEqual(
      fast('address', '0x' + word('bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')),
      ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'],
    );
  });
});
