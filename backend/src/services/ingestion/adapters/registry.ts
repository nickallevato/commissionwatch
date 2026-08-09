import {
  ADAPTER_KEY_MAX_LENGTH,
  ADAPTER_KEY_PATTERN,
  type SourceAdapter,
} from './types';

/**
 * The adapter registry.
 *
 * `ingestion_sources.adapter_key` names an adapter; this is what turns that
 * string back into code. It is deliberately dumb: registration validates the key
 * and the descriptor agreement, lookup either returns an adapter or throws. Core
 * never branches on jurisdiction, so adding one is a `register` call.
 */

export class InvalidAdapterError extends Error {
  constructor(
    readonly adapterKey: string,
    reason: string,
  ) {
    super(`Invalid adapter '${adapterKey}': ${reason}`);
    this.name = 'InvalidAdapterError';
  }
}

export class DuplicateAdapterKeyError extends Error {
  constructor(readonly adapterKey: string) {
    super(`Adapter key '${adapterKey}' is already registered`);
    this.name = 'DuplicateAdapterKeyError';
  }
}

export class UnknownAdapterKeyError extends Error {
  constructor(
    readonly adapterKey: string,
    readonly knownKeys: string[],
  ) {
    const known = knownKeys.length > 0 ? knownKeys.join(', ') : '(none registered)';
    super(`No adapter registered for key '${adapterKey}'. Known keys: ${known}`);
    this.name = 'UnknownAdapterKeyError';
  }
}

export interface AdapterRegistry {
  /** Throws {@link DuplicateAdapterKeyError} or {@link InvalidAdapterError}. */
  register(adapter: SourceAdapter): void;
  /** Throws {@link UnknownAdapterKeyError} when absent — never returns undefined. */
  get(key: string): SourceAdapter;
  has(key: string): boolean;
  /** Registered keys, sorted, for status pages and error messages. */
  keys(): string[];
  /** Every adapter, ordered by key. */
  all(): SourceAdapter[];
}

/**
 * Rejects an adapter whose key is unusable or whose descriptor disagrees with it.
 * A descriptor claiming a different key than the adapter it came from would send
 * `ingestion_sources` rows to the wrong module, so it is refused at the door.
 */
export function assertValidAdapter(adapter: SourceAdapter): void {
  const key = adapter.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidAdapterError(String(key), 'key must be a non-empty string');
  }
  if (key.length > ADAPTER_KEY_MAX_LENGTH) {
    throw new InvalidAdapterError(
      key,
      `key exceeds ${ADAPTER_KEY_MAX_LENGTH} characters (ingestion_sources.adapter_key)`,
    );
  }
  if (!ADAPTER_KEY_PATTERN.test(key)) {
    throw new InvalidAdapterError(key, 'key must be lowercase kebab-case, e.g. gallatin-civicplus');
  }

  const descriptor = adapter.describeSource();
  if (descriptor.key !== key) {
    throw new InvalidAdapterError(
      key,
      `describeSource().key is '${descriptor.key}' but adapter.key is '${key}'`,
    );
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createAdapterRegistry(adapters: SourceAdapter[] = []): AdapterRegistry {
  const byKey = new Map<string, SourceAdapter>();

  const registry: AdapterRegistry = {
    register(adapter: SourceAdapter): void {
      assertValidAdapter(adapter);
      if (byKey.has(adapter.key)) {
        throw new DuplicateAdapterKeyError(adapter.key);
      }
      byKey.set(adapter.key, adapter);
    },

    get(key: string): SourceAdapter {
      const adapter = byKey.get(key);
      if (!adapter) {
        throw new UnknownAdapterKeyError(key, registry.keys());
      }
      return adapter;
    },

    has(key: string): boolean {
      return byKey.has(key);
    },

    keys(): string[] {
      return [...byKey.keys()].sort(compareKeys);
    },

    all(): SourceAdapter[] {
      return [...byKey.entries()]
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([, adapter]) => adapter);
    },
  };

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return registry;
}

/**
 * The process-wide registry. Empty until adapter modules register themselves;
 * the existing hardcoded Bozeman scraper in `src/scraper/` has not been ported
 * to this interface yet.
 */
export const adapterRegistry: AdapterRegistry = createAdapterRegistry();
