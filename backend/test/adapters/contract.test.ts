import {
  sha256Hex,
  type DocumentRef,
  type FetchedArtifact,
  type MeetingRef,
  type SourceAdapter,
  type SourceDescriptor,
} from '../../src/services/ingestion/adapters/types';
import { runAdapterContract } from './contract';

/**
 * The shared contract suite, proved against a reference adapter.
 *
 * `runAdapterContract` itself lives in `./contract.ts` — a helper, not a test
 * file — so that a real adapter's suite can use it without one test file
 * importing another. See the note at the top of that file for what that cost.
 */
/**
 * A minimal in-memory adapter, present so the shared suite is itself tested. It
 * is also the smallest complete example of what an adapter must provide.
 */
export function createReferenceAdapter(): SourceAdapter {
  const key = 'reference-fixture';
  const baseUrl = 'https://reference.invalid';
  const listingUrl = `${baseUrl}/commission/meetings`;

  const encoder = new TextEncoder();
  const bytesByUrl = new Map<string, Uint8Array>([
    [`${baseUrl}/docs/2025-03-04-agenda.pdf`, encoder.encode('AGENDA 2025-03-04\nItem 1. Zoning.\n')],
    [`${baseUrl}/docs/2025-03-04-minutes.pdf`, encoder.encode('MINUTES 2025-03-04\nApproved 4-1.\n')],
  ]);

  const documents: DocumentRef[] = [
    {
      sourceKey: key,
      kind: 'agenda',
      title: 'Agenda - 2025-03-04',
      url: `${baseUrl}/docs/2025-03-04-agenda.pdf`,
      meetingExternalId: 'ref-2025-03-04',
      expectedContentType: 'application/pdf',
    },
    {
      sourceKey: key,
      kind: 'minutes',
      title: 'Minutes - 2025-03-04',
      url: `${baseUrl}/docs/2025-03-04-minutes.pdf`,
      meetingExternalId: 'ref-2025-03-04',
      expectedContentType: 'application/pdf',
    },
  ];

  const allMeetings: MeetingRef[] = [
    {
      sourceKey: key,
      bodyKey: 'commission',
      date: '2025-03-04',
      time: '18:00',
      timezone: 'America/Denver',
      status: 'completed',
      title: 'Regular Commission Meeting',
      location: 'Commission Room',
      externalId: 'ref-2025-03-04',
      sourceUrl: listingUrl,
      documents,
    },
    {
      sourceKey: key,
      bodyKey: 'commission',
      date: '2024-11-19',
      timezone: 'America/Denver',
      status: 'completed',
      externalId: 'ref-2024-11-19',
      sourceUrl: listingUrl,
      documents: [],
    },
  ];

  return {
    key,

    describeSource(): SourceDescriptor {
      // Rebuilt each call: callers must not be able to mutate the descriptor.
      return {
        key,
        jurisdiction: {
          name: 'Reference County',
          state: 'MT',
          type: 'county',
          websiteUrl: baseUrl,
        },
        bodies: [{ key: 'commission', name: 'Reference County Commission', listingUrl }],
        baseUrls: [baseUrl],
        politeness: {
          minDelayMs: 1000,
          maxConcurrency: 1,
          userAgent:
            'CommissionWatch/1.0 (civic transparency tool; contact: admin@commissionwatch.org)',
          respectRobotsTxt: true,
          maxRetries: 3,
        },
        supportsLiveFetch: true,
      };
    },

    async discoverMeetings(since: Date): Promise<MeetingRef[]> {
      const sinceDate = since.toISOString().slice(0, 10);
      return allMeetings.filter((meeting) => meeting.date >= sinceDate);
    },

    async fetchDocument(ref: DocumentRef): Promise<FetchedArtifact> {
      const bytes = bytesByUrl.get(ref.url);
      if (!bytes) {
        throw new Error(`No fixture bytes for ${ref.url}`);
      }
      const copy = Uint8Array.from(bytes);
      return {
        bytes: copy,
        contentType: 'application/pdf',
        sourceUrl: ref.url,
        sha256: sha256Hex(copy),
        byteSize: copy.length,
        fetchedAt: new Date().toISOString(),
        ref,
      };
    },
  };
}

// The shared suite, proved against the reference adapter. Unconditional now:
// nothing imports this file, so there is nothing to guard against.
runAdapterContract(createReferenceAdapter(), {
  since: new Date('2025-01-01T00:00:00Z'),
  minMeetings: 1,
});
