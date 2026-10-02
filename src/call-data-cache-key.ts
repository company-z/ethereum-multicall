/**
 * Cache key for one inner call's encoded calldata, or undefined when the
 * parameters are not safe to key on.
 *
 * The same calls repeat from batch to batch (balanceOf on the same pools,
 * getReserves, slot0...), and each one otherwise goes through ethers'
 * `encodeFunctionData` again. Only primitive parameters (and arrays of them)
 * are keyed: their JSON is unambiguous and they cannot be mutated after the
 * call is encoded. Anything else -- BigNumber objects, bigint, null/undefined,
 * nested objects -- is encoded fresh, exactly as before.
 */
export function callDataCacheKey(
  abiKey: string,
  methodName: string,
  methodParameters: unknown[] | undefined
): string | undefined {
  const params = methodParameters ?? [];
  if (!params.every(isKeyablePrimitive)) return undefined;
  return `${abiKey}\u0000${methodName}\u0000${JSON.stringify(params)}`;
}

function isKeyablePrimitive(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isSafeInteger(value);
    case 'object':
      return Array.isArray(value) && value.every(isKeyablePrimitive);
    default:
      return false;
  }
}
