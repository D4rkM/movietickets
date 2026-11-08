/** Drops `undefined` entries, so a PATCH only touches the fields the client actually sent (`null` is kept). */
export function definedFields<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
