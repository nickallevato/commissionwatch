/**
 * The shared adapter contract suite.
 *
 * Deliberately NOT named `*.test.ts`. It used to be, and `gallatin-civicplus.test.ts`
 * imported `runAdapterContract` from it — a test file importing another test file.
 * Under `node --test --test-force-exit` that made the importing process exit
 * partway through registration, so the Gallatin suite reported 34, 36 or 42 of
 * its 68 tests depending on timing, **all green**, with no indication that
 * anything had been skipped. Silently unrun tests are the exact defect that
 * once left four suites and 135 tests unexecuted in this repo, so the import is
 * gone rather than worked around.
 */
import { before as beforeAll, describe, it } from 'node:test';
import { expect } from '../helpers/expect';
import {
  ISO_DATE_PATTERN,
  LOCAL_TIME_PATTERN,
  MIN_POLITENESS_DELAY_MS,
  SHA256_HEX_PATTERN,
  isAbsoluteHttpUrl,
  isCalendarDate,
  isIanaTimeZone,
  sha256Hex,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type SourceAdapter,
  type SourceDescriptor,
} from '../../src/services/ingestion/adapters/types';
import { assertValidAdapter, createAdapterRegistry } from '../../src/services/ingestion/adapters/registry';

/**
 * The shared adapter contract suite.
 *
 * Every source adapter runs this one suite against its captured fixtures. Adding
 * a jurisdiction means passing an existing suite, not writing a new one:
 *
 * ```ts
 * // src/adapters/gallatin-civicplus.test.ts
 * import { runAdapterContract } from './contract.test';
 * runAdapterContract(createGallatinAdapter({ transport: fixtureTransport }), {
 *   since: new Date('2025-01-01T00:00:00Z'),
 * });
 * ```
 *
 * The adapter under test is constructed with a fixture-backed transport, so the
 * suite never touches the network — the same property that lets every stage
 * after `fetch` develop at full speed against stored artifacts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const MEETING_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
const DOCUMENT_KINDS = [
  'agenda',
  'minutes',
  'packet',
  'resolution',
  'ordinance',
  'attachment',
  'other',
] as const;

export interface AdapterContractFixtures {
  /** The `since` handed to `discoverMeetings`. Must precede the fixture meetings. */
  since: Date;
  /** How many refs the fixture set must yield. Default 1. */
  minMeetings?: number;
  /**
   * The document fetched twice to prove the content address is stable. Defaults
   * to the first document of the first discovered meeting.
   */
  documentRef?: DocumentRef;
}

/**
 * Registers the contract suite for `adapter`. Call at the top level of the
 * adapter's own test file.
 */
export function runAdapterContract(
  adapter: SourceAdapter,
  fixtures: AdapterContractFixtures,
): void {
  const minMeetings = fixtures.minMeetings ?? 1;

  describe(`SourceAdapter contract: ${adapter.key}`, () => {
    let descriptor: SourceDescriptor;
    let meetings: MeetingRef[];

    beforeAll(async () => {
      descriptor = adapter.describeSource();
      meetings = await adapter.discoverMeetings(fixtures.since);
    });

    describe('describeSource', () => {
      it('returns a descriptor whose key is the adapter key', () => {
        expect(descriptor.key).toBe(adapter.key);
        expect(() => assertValidAdapter(adapter)).not.toThrow();
      });

      it('names a jurisdiction the database can hold', () => {
        expect(descriptor.jurisdiction.name.trim().length).toBeGreaterThan(0);
        // jurisdictions.state is varchar(2).
        expect(descriptor.jurisdiction.state).toMatch(/^[A-Z]{2}$/);
        expect(['city', 'county']).toContain(descriptor.jurisdiction.type);
        if (descriptor.jurisdiction.websiteUrl !== undefined) {
          expect(isAbsoluteHttpUrl(descriptor.jurisdiction.websiteUrl)).toBe(true);
        }
      });

      it('declares at least one body, each with a listing URL', () => {
        expect(descriptor.bodies.length).toBeGreaterThan(0);
        for (const body of descriptor.bodies) {
          expect(body.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          expect(body.name.trim().length).toBeGreaterThan(0);
          expect(isAbsoluteHttpUrl(body.listingUrl)).toBe(true);
        }
      });

      it('declares unique body keys', () => {
        const keys = descriptor.bodies.map((body) => body.key);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('declares every origin it will touch', () => {
        expect(descriptor.baseUrls.length).toBeGreaterThan(0);
        for (const baseUrl of descriptor.baseUrls) {
          expect(isAbsoluteHttpUrl(baseUrl)).toBe(true);
        }
        // A listing URL outside the declared surface means the declaration lies.
        const declaredOrigins = new Set(descriptor.baseUrls.map((url) => new URL(url).origin));
        for (const body of descriptor.bodies) {
          expect(declaredOrigins).toContain(new URL(body.listingUrl).origin);
        }
      });

      it('declares a politeness delay', () => {
        const { politeness } = descriptor;
        expect(politeness.minDelayMs).toBeGreaterThanOrEqual(MIN_POLITENESS_DELAY_MS);
        expect(politeness.maxConcurrency).toBeGreaterThanOrEqual(1);
        expect(politeness.maxRetries).toBeGreaterThanOrEqual(0);
        expect(typeof politeness.respectRobotsTxt).toBe('boolean');
      });

      it('declares an honest user agent naming the project and a contact', () => {
        const { userAgent } = descriptor.politeness;
        expect(userAgent).toMatch(/CommissionWatch/i);
        // A contact address or URL, so an operator being scraped can reach a human.
        expect(userAgent).toMatch(/@|https?:\/\//);
      });

      it('states whether live fetching is available', () => {
        expect(typeof descriptor.supportsLiveFetch).toBe('boolean');
      });

      it('is pure: repeated calls agree and do not share mutable state', () => {
        const first = adapter.describeSource();
        const second = adapter.describeSource();
        expect(second).toEqual(first);
        expect(second.bodies).not.toBe(first.bodies);
        expect(second.baseUrls).not.toBe(first.baseUrls);
      });
    });

    describe('discoverMeetings', () => {
      it('discovers the fixture meetings', () => {
        expect(meetings.length).toBeGreaterThanOrEqual(minMeetings);
      });

      it('attributes every ref to this adapter and a declared body', () => {
        const bodyKeys = new Set(descriptor.bodies.map((body) => body.key));
        for (const ref of meetings) {
          expect(ref.sourceKey).toBe(adapter.key);
          expect(bodyKeys).toContain(ref.bodyKey);
        }
      });

      it('emits parseable ISO dates in a real time zone', () => {
        for (const ref of meetings) {
          expect(ref.date).toMatch(ISO_DATE_PATTERN);
          // Rejects 2025-02-30 and friends, which Date rolls forward silently.
          expect(isCalendarDate(ref.date)).toBe(true);
          expect(Number.isNaN(Date.parse(`${ref.date}T00:00:00Z`))).toBe(false);
          if (ref.time !== undefined) {
            expect(ref.time).toMatch(LOCAL_TIME_PATTERN);
          }
          expect(isIanaTimeZone(ref.timezone)).toBe(true);
        }
      });

      it('returns nothing older than `since`', () => {
        // One day of slack: `since` is an instant, `date` is a local calendar day.
        const floorMs =
          Date.UTC(
            fixtures.since.getUTCFullYear(),
            fixtures.since.getUTCMonth(),
            fixtures.since.getUTCDate(),
          ) - DAY_MS;
        for (const ref of meetings) {
          expect(Date.parse(`${ref.date}T00:00:00Z`)).toBeGreaterThanOrEqual(floorMs);
        }
      });

      it('emits a status the meetings table accepts', () => {
        for (const ref of meetings) {
          expect(MEETING_STATUSES).toContain(ref.status);
        }
      });

      it('carries provenance on every ref', () => {
        for (const ref of meetings) {
          expect(isAbsoluteHttpUrl(ref.sourceUrl)).toBe(true);
        }
      });

      it('does not repeat a meeting within one sweep', () => {
        const identities = meetings.map(
          (ref) => ref.externalId ?? `${ref.bodyKey}|${ref.date}|${ref.time ?? ''}`,
        );
        expect(new Set(identities).size).toBe(identities.length);
      });

      it('emits well-formed document refs', () => {
        for (const ref of meetings) {
          expect(Array.isArray(ref.documents)).toBe(true);
          for (const doc of ref.documents) {
            expect(doc.sourceKey).toBe(adapter.key);
            expect(DOCUMENT_KINDS).toContain(doc.kind);
            expect(doc.title.trim().length).toBeGreaterThan(0);
            expect(isAbsoluteHttpUrl(doc.url)).toBe(true);
          }
        }
      });
    });

    describe('fetchDocument', () => {
      let ref: DocumentRef;
      let artifact: FetchedArtifact;

      beforeAll(async () => {
        const fallback = meetings.flatMap((meeting) => meeting.documents)[0];
        const chosen = fixtures.documentRef ?? fallback;
        if (!chosen) {
          throw new Error(
            `Adapter '${adapter.key}' has no fetchable document fixture: pass fixtures.documentRef ` +
              'or have discoverMeetings return a meeting carrying at least one document.',
          );
        }
        ref = chosen;
        artifact = await adapter.fetchDocument(ref);
      });

      it('returns the bytes', () => {
        expect(artifact.bytes).toBeInstanceOf(Uint8Array);
        expect(artifact.bytes.length).toBeGreaterThan(0);
        expect(artifact.byteSize).toBe(artifact.bytes.length);
      });

      it('carries a content type', () => {
        // Nullable, matching artifacts.content_type: a source may send none.
        expect(
          artifact.contentType === null || typeof artifact.contentType === 'string',
        ).toBe(true);
        if (artifact.contentType !== null) {
          expect(artifact.contentType.trim().length).toBeGreaterThan(0);
        }
      });

      it('carries the source URL it fetched', () => {
        expect(isAbsoluteHttpUrl(artifact.sourceUrl)).toBe(true);
      });

      it('carries the ref it answers and an ISO fetch time', () => {
        expect(artifact.ref.url).toBe(ref.url);
        expect(Number.isNaN(Date.parse(artifact.fetchedAt))).toBe(false);
        expect(artifact.fetchedAt).toBe(new Date(artifact.fetchedAt).toISOString());
      });

      it('content-addresses the bytes with a lowercase hex sha256', () => {
        expect(artifact.sha256).toMatch(SHA256_HEX_PATTERN);
        expect(artifact.sha256).toBe(sha256Hex(artifact.bytes));
      });

      it('produces a stable sha256 for identical bytes', async () => {
        // The property that makes re-fetching an unchanged document a no-op:
        // the address depends on the bytes and on nothing else.
        const again = await adapter.fetchDocument(ref);
        expect(Array.from(again.bytes)).toEqual(Array.from(artifact.bytes));
        expect(again.sha256).toBe(artifact.sha256);
        expect(sha256Hex(Uint8Array.from(artifact.bytes))).toBe(artifact.sha256);
      });
    });

    describe('registration', () => {
      it('registers and resolves under its key', () => {
        const registry = createAdapterRegistry([adapter]);
        expect(registry.get(adapter.key)).toBe(adapter);
        expect(registry.keys()).toEqual([adapter.key]);
      });
    });
  });
}
