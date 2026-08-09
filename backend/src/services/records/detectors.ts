import {
  parseAmount,
  parseExtractedDate,
  type ExtractedEntities,
} from './extraction';

/**
 * The three detectors a public-records document can trigger, ported from the
 * archive's document-digger.
 *
 * Each one keys on language, a numeric delta, or a timeline. **None takes an
 * entity class as an input**, so none can be aimed at one category of
 * counterparty — non-partisanship here is a property of the signatures, not of
 * anyone's restraint.
 *
 * Every flag carries evidence: what was seen, not only what was concluded.
 * That is the project's standing rule — describe the record, never the motive.
 * None of these descriptions asserts intent, corruption or illegality; each
 * says what the document contains and stops.
 */

export type RecordsFlagType = 'no_bid_contract' | 'budget_spike' | 'fast_tracked_permit';

export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RecordsFlag {
  flag_type: RecordsFlagType;
  severity: FlagSeverity;
  description: string;
  evidence: Record<string, string | number | string[]>;
}

const SOLE_SOURCE_TERMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'no-bid', pattern: /no[-\s]?bid/i },
  { label: 'sole source', pattern: /sole[-\s]?source/i },
  { label: 'single source', pattern: /single[-\s]?source/i },
];

const EXPEDITED_TERMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'expedited', pattern: /expedited/i },
  { label: 'fast-track', pattern: /fast[-\s]?track/i },
  { label: 'administrative approval', pattern: /administrative approval/i },
];

/** The largest amount must be this many times the smallest to count as a spike. */
const SPIKE_RATIO = 3;
/** …and this many dollars apart, so 30 vs 10 is not a "budget spike". */
const SPIKE_ABSOLUTE_DELTA = 50_000;
/** All dates inside this many days is a compressed timeline. */
const FAST_TRACK_DAYS = 14;

export function detectRecordsFlags(text: string, entities: ExtractedEntities): RecordsFlag[] {
  const flags: RecordsFlag[] = [];

  const soleSource = SOLE_SOURCE_TERMS.filter((term) => term.pattern.test(text)).map(
    (term) => term.label,
  );
  if (soleSource.length > 0) {
    flags.push({
      flag_type: 'no_bid_contract',
      severity: 'high',
      description: 'Document references a sole-source or no-bid procurement path.',
      evidence: { matched_terms: soleSource },
    });
  }

  const amounts = entities.amounts
    .map((entry) => parseAmount(entry.value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (amounts.length >= 2) {
    const min = amounts[0];
    const max = amounts[amounts.length - 1];
    if (max >= min * SPIKE_RATIO && max - min >= SPIKE_ABSOLUTE_DELTA) {
      flags.push({
        flag_type: 'budget_spike',
        severity: 'medium',
        description: 'Document contains a large budget delta that merits review.',
        evidence: {
          smallest_amount: min,
          largest_amount: max,
          ratio: Number((max / min).toFixed(2)),
        },
      });
    }
  }

  const expedited = EXPEDITED_TERMS.filter((term) => term.pattern.test(text)).map(
    (term) => term.label,
  );
  if (expedited.length > 0) {
    const parsedDates = entities.dates
      .map((entry) => parseExtractedDate(entry.value))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);

    if (parsedDates.length >= 2) {
      const dayGap = Math.round(
        (parsedDates[parsedDates.length - 1] - parsedDates[0]) / 86_400_000,
      );
      if (dayGap <= FAST_TRACK_DAYS) {
        flags.push({
          flag_type: 'fast_tracked_permit',
          severity: 'medium',
          description: 'Permit language indicates an unusually compressed approval timeline.',
          evidence: {
            matched_terms: expedited,
            first_date: new Date(parsedDates[0]).toISOString().slice(0, 10),
            last_date: new Date(parsedDates[parsedDates.length - 1]).toISOString().slice(0, 10),
            day_gap: dayGap,
          },
        });
      }
    }
  }

  return flags;
}
