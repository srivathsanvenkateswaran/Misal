/**
 * Descriptors are data, and they are loaded as text.
 *
 * A CSV mapping descriptor is validated at runtime by the Zod schema in `src/ingestion/csv`, which
 * is the whole point of the format: adding a broker is a data change, not a code change. Importing
 * the YAML as a string keeps that true — nothing here compiles a descriptor into the bundle as
 * structure, so a malformed one produces the loader's line-and-column error rather than a build
 * failure a contributor cannot read.
 */
declare module '*.yaml?raw' {
  const source: string
  export default source
}
