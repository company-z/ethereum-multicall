/**
 * Hand-rolled ABI encoding for the Multicall2 wrapper calls:
 *
 *   aggregate((address target, bytes callData)[] calls)
 *   tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls)
 *
 * ethers' generic coder walks every byte of every inner `callData` through its
 * Writer (arrayify -> padded copies -> hexlify), so wrapping a batch of already
 * encoded calls cost more than encoding them did: in a production CPU profile
 * of token-handlers (BSC, 2026-10-02) the wrapper encode alone was ~3.5 ms of
 * main-thread time per block. The layout here is fixed, so it is plain string
 * concatenation of hex.
 *
 * Output is byte-identical to `Interface.encodeFunctionData` (lowercase hex).
 * Input ethers would reject -- a target or callData that is not plain hex, a
 * mixed-case target whose checksum is wrong -- returns `undefined` so the
 * caller falls back to ethers and gets ethers' error for it.
 */

import { utils } from 'ethers';

/** keccak256("aggregate((address,bytes)[])")[0:4] */
export const AGGREGATE_SELECTOR = '0x252dba42';
/** keccak256("tryBlockAndAggregate(bool,(address,bytes)[])")[0:4] */
export const TRY_BLOCK_AND_AGGREGATE_SELECTOR = '0x399542e9';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const ZERO_WORD = '0'.repeat(64);

function word(value: number): string {
  return value.toString(16).padStart(64, '0');
}

/** A 20-byte address as a lowercase 32-byte word, or undefined to defer to ethers. */
function addressWord(address: string): string | undefined {
  if (!ADDRESS_RE.test(address)) return undefined;
  const body = address.slice(2);
  const lower = body.toLowerCase();
  // All-lower or all-upper carry no checksum. Mixed case is a checksum claim
  // that ethers' address coder verifies, so verify it the same way.
  if (
    body !== lower &&
    body !== body.toUpperCase() &&
    !isVerifiedChecksum(address)
  ) {
    return undefined;
  }
  return lower.padStart(64, '0');
}

// Checksummed addresses already verified. The same pools and tokens recur in
// every batch, and the keccak behind each check was most of what remained of
// the encode. Cleared wholesale when full: a miss only costs a re-check.
const verifiedChecksums = new Set<string>();
const MAX_VERIFIED_CHECKSUMS = 50_000;

function isVerifiedChecksum(address: string): boolean {
  if (verifiedChecksums.has(address)) return true;
  try {
    if (utils.getAddress(address) !== address) return false;
  } catch {
    return false;
  }
  if (verifiedChecksums.size >= MAX_VERIFIED_CHECKSUMS) verifiedChecksums.clear();
  verifiedChecksums.add(address);
  return true;
}

/**
 * Encode the `(address,bytes)[]` argument as it appears at its offset: length,
 * then one offset per element (relative to the end of the length word), then
 * the elements. Returns undefined when any element needs ethers' validation.
 */
function encodeCallsArray(
  calls: ReadonlyArray<{ target: string; callData: string }>
): string | undefined {
  const heads: string[] = new Array(calls.length);
  const tails: string[] = new Array(calls.length);
  let offset = calls.length * 32;

  for (let i = 0; i < calls.length; i++) {
    const { target, callData } = calls[i];
    const targetWord = addressWord(target);
    if (targetWord === undefined || !HEX_RE.test(callData)) return undefined;

    const data = callData.slice(2).toLowerCase();
    const byteLength = data.length / 2;
    const padding = (64 - (data.length % 64)) % 64;
    // (address, bytes): address word, offset of bytes within the tuple (0x40),
    // then the bytes' length and right-padded content.
    const tuple =
      targetWord + word(64) + word(byteLength) + data + ZERO_WORD.slice(0, padding);

    heads[i] = word(offset);
    tails[i] = tuple;
    offset += tuple.length / 2;
  }

  return word(calls.length) + heads.join('') + tails.join('');
}

/**
 * Calldata for `aggregate(calls)` or `tryBlockAndAggregate(false, calls)`, or
 * undefined when the caller should encode with ethers instead.
 */
export function encodeAggregateCallData(
  calls: ReadonlyArray<{ target: string; callData: string }>,
  tryAggregate: boolean
): string | undefined {
  const array = encodeCallsArray(calls);
  if (array === undefined) return undefined;

  if (tryAggregate) {
    // requireSuccess = false, then the offset of the dynamic array (two head words).
    return TRY_BLOCK_AND_AGGREGATE_SELECTOR + ZERO_WORD + word(64) + array;
  }
  return AGGREGATE_SELECTOR + word(32) + array;
}
