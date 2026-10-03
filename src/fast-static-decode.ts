import { ethers } from 'ethers';

/**
 * Return-data decode for calls whose outputs are all static value types
 * (`getReserves() -> (uint112, uint112, uint32)`, `slot0()`, `fee() ->
 * uint24`, `tickSpacing() -> int24`, ...), read word by word instead of
 * through ethers' `defaultAbiCoder.decode` + `formatReturnValues`.
 *
 * `fastDecodeSimpleType` only covers a single uint/int of a few widths,
 * address, bool or bytes32; everything else went through the full decoder,
 * ~1 ms/block of token-handlers' main thread on BSC (production profile,
 * 2026-10-03).
 *
 * The output is exactly what the full path returns:
 * - uintN / intN masked to N bits (two's complement for intN): a JS number
 *   at <= 48 bits (ethers' Reader.coerce), a decimal string above
 *   (normalizeValue's BigNumber.toString());
 * - checksummed address; boolean; lowercase bytesN;
 * - one output: `[value]`; several: an array of the values plus each
 *   uniquely named output as a property, `length` renamed `_length`, and a
 *   name already present on the array (an Array method) skipped — ethers'
 *   tuple `unpack` rules, as copied by formatReturnValues.
 *
 * Returns null — the caller uses the full decoder — for anything else: a
 * dynamic, tuple or array output, a numeric-looking output name, return data that is not exactly one word
 * per output, non-hex data, or an address word with dirty upper bytes (an
 * Error value in ethers' Result).
 */

type StaticField =
  | { kind: 'uint' | 'int'; bits: number; name: string }
  | { kind: 'address' | 'bool'; name: string }
  | { kind: 'bytes'; size: number; name: string };

type Plan = {
  fields: StaticField[];
  // Property name per field index, or null when ethers gives it none.
  propertyNames: (string | null)[];
  hexLength: number;
};

type OutputParam = { type: string; name?: string };

const HEX = /^0x[0-9a-fA-F]*$/;
const ZERO_HEX = /^0*$/;
const ADDRESS_PAD = '0'.repeat(24);

const plans = new WeakMap<readonly OutputParam[], Plan | null>();

const staticField = (output: OutputParam): StaticField | null => {
  const name = output.name ?? '';
  const type = output.type;
  if (type === 'address' || type === 'bool') return { kind: type, name };
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const bits = int[2] === '' ? 256 : Number(int[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) return null;
    return { kind: int[1] ? 'uint' : 'int', bits, name };
  }
  const bytes = /^bytes(\d+)$/.exec(type);
  if (bytes) {
    const size = Number(bytes[1]);
    if (size < 1 || size > 32) return null;
    return { kind: 'bytes', size, name };
  }
  return null;
};

const buildPlan = (outputs: readonly OutputParam[]): Plan | null => {
  if (outputs.length === 0) return null;
  const fields: StaticField[] = [];
  for (const output of outputs) {
    // A tuple has `components`; its type is "tuple" and fails staticField.
    const field = staticField(output);
    if (!field) return null;
    // A numeric-looking name makes ethers write an array index (`values[7]`),
    // stretching the Result: leave that to the full decoder.
    if (field.name && !isNaN(Number(field.name))) return null;
    fields.push(field);
  }

  const nameCounts = new Map<string, number>();
  for (const { name } of fields) {
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const probe: unknown[] = [];
  const taken = new Set<string>();
  const propertyNames = fields.map(({ name }) => {
    if (!name || nameCounts.get(name) !== 1) return null;
    const property = name === 'length' ? '_length' : name;
    // ethers skips a name the array already answers (Array methods) or one
    // an earlier field took.
    if ((probe as unknown as Record<string, unknown>)[property] != null) {
      return null;
    }
    if (taken.has(property)) return null;
    taken.add(property);
    return property;
  });

  return { fields, propertyNames, hexLength: 2 + 64 * fields.length };
};

const planFor = (outputs: readonly OutputParam[]): Plan | null => {
  let plan = plans.get(outputs);
  if (plan === undefined) {
    plan = buildPlan(outputs);
    plans.set(outputs, plan);
  }
  return plan;
};

// One word as ethers decodes it and normalizeValue then formats it;
// undefined when ethers would not decode it cleanly.
const decodeWord = (word: string, field: StaticField): unknown => {
  switch (field.kind) {
    case 'address':
      if (word.slice(0, 24) !== ADDRESS_PAD) return undefined;
      return ethers.utils.getAddress('0x' + word.slice(24).toLowerCase());
    case 'bool':
      return !ZERO_HEX.test(word);
    case 'bytes':
      return '0x' + word.slice(0, field.size * 2).toLowerCase();
    case 'uint': {
      const hex = word.slice(64 - field.bits / 4);
      return field.bits <= 48
        ? parseInt(hex, 16)
        : BigInt('0x' + hex).toString(10);
    }
    case 'int': {
      const hex = word.slice(64 - field.bits / 4);
      let value = BigInt('0x' + hex);
      if (value >> BigInt(field.bits - 1)) value -= 1n << BigInt(field.bits);
      return field.bits <= 48 ? Number(value) : value.toString(10);
    }
  }
};

export function fastDecodeStaticOutputs(
  returnData: string,
  outputs: readonly OutputParam[]
): any[] | null {
  const plan = planFor(outputs);
  if (!plan) return null;
  if (typeof returnData !== 'string') return null;
  if (returnData.length !== plan.hexLength || !HEX.test(returnData)) {
    return null;
  }

  const values: any[] = new Array(plan.fields.length);
  for (let i = 0; i < plan.fields.length; i++) {
    const start = 2 + i * 64;
    const value = decodeWord(returnData.slice(start, start + 64), plan.fields[i]);
    if (value === undefined) return null;
    values[i] = value;
  }

  // formatReturnValues unwraps a one-value Result, dropping its name.
  if (values.length === 1) return values;

  for (let i = 0; i < values.length; i++) {
    const property = plan.propertyNames[i];
    if (property !== null) (values as any)[property] = values[i];
  }
  return values;
}
