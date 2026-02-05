export class Utils {
  /**
   * Deep clone an object
   * Uses structuredClone when available (10x faster than JSON.parse/stringify)
   * @param object The object
   */
  public static deepClone<T>(object: T): T {
    // For primitives, just return the value directly
    if (object === null || typeof object !== 'object') {
      return object;
    }
    
    // Use structuredClone if available (Node 17+, modern browsers)
    if (typeof structuredClone === 'function') {
      return structuredClone(object);
    }
    
    // Fallback to JSON method for older environments
    return JSON.parse(JSON.stringify(object)) as T;
  }

  /**
   * Shallow clone an object (much faster for simple objects)
   * @param object The object
   */
  public static shallowClone<T extends object>(object: T): T {
    return { ...object } as T;
  }
}
