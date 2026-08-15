import type {
  Jurisdiction,
  Commission,
  Meeting,
  AgendaItem,
  MeetingDocument,
  Member,
  Vote,
  AnomalyFlag,
  Matter,
  MatterAppearance,
  Metrics,
} from "@/types";

/**
 * The people, jurisdictions and votes in this file are invented. The names are
 * generic on purpose and every address and link points at `example.invalid`,
 * a domain the DNS standard reserves so it can never resolve.
 *
 * They used to read `schen@denver.gov` and `https://bouldercounty.gov`. On a
 * project whose entire claim is that what it publishes about an official is
 * sourced and true, a fabricated commissioner reachable at a real city's real
 * domain is the one kind of fixture that must not exist — someone reading a
 * screenshot cannot tell the difference, and neither can a scraper.
 *
 * Every `id` and foreign key below is a real UUID, because every corresponding
 * column is `uuid` and the API routes reject anything that fails
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` with 400.
 *
 * They follow a readable convention so cross-references stay auditable:
 *   1xxxxxxx… jurisdictions   6xxxxxxx… anomaly flags
 *   2xxxxxxx… commissions
 *   3xxxxxxx… meetings        8xxxxxxx… members
 *   4xxxxxxx… agenda items    9xxxxxxx… votes
 *   5xxxxxxx… meeting documents
 */

export const jurisdictions: Jurisdiction[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Denver",
    state: "CO",
    type: "city",
    website_url: "https://example.invalid/denver",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    name: "Boulder County",
    state: "CO",
    type: "county",
    website_url: "https://example.invalid/boulder",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    name: "Austin",
    state: "TX",
    type: "city",
    website_url: "https://austintexas.gov",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

export const commissions: Commission[] = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    jurisdiction_id: "10000000-0000-4000-8000-000000000001",
    name: "Planning & Zoning Commission",
    description: "Reviews land use and zoning applications",
    meeting_schedule: "1st and 3rd Tuesday",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    jurisdiction_id: "10000000-0000-4000-8000-000000000002",
    name: "Board of County Commissioners",
    description: "Main governing body for Boulder County",
    meeting_schedule: "Every Tuesday",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "20000000-0000-4000-8000-000000000003",
    jurisdiction_id: "10000000-0000-4000-8000-000000000003",
    name: "Planning Commission",
    description: "Reviews development proposals and zoning changes",
    meeting_schedule: "2nd and 4th Tuesday",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

export const meetings: Meeting[] = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    commission_id: "20000000-0000-4000-8000-000000000001",
    date: "2024-12-03",
    time: "18:00",
    location: "City Hall, Room 450",
    status: "completed",
    agenda_url: "https://example.com/agenda1.pdf",
    minutes_url: "https://example.com/minutes1.pdf",
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-12-04T00:00:00Z",
    published_at: "2024-12-04T00:00:00Z",
    commission: { ...commissions[0], jurisdiction: jurisdictions[0] },
  },
  {
    id: "30000000-0000-4000-8000-000000000002",
    commission_id: "20000000-0000-4000-8000-000000000001",
    date: "2024-12-17",
    time: "18:00",
    location: "City Hall, Room 450",
    status: "scheduled",
    agenda_url: "https://example.com/agenda2.pdf",
    minutes_url: null,
    created_at: "2024-12-01T00:00:00Z",
    updated_at: "2024-12-01T00:00:00Z",
    published_at: "2024-12-01T00:00:00Z",
    commission: { ...commissions[0], jurisdiction: jurisdictions[0] },
  },
  {
    id: "30000000-0000-4000-8000-000000000003",
    commission_id: "20000000-0000-4000-8000-000000000002",
    date: "2024-12-10",
    time: "09:30",
    location: "Boulder County Courthouse",
    status: "completed",
    agenda_url: "https://example.com/agenda3.pdf",
    minutes_url: "https://example.com/minutes3.pdf",
    created_at: "2024-12-01T00:00:00Z",
    updated_at: "2024-12-11T00:00:00Z",
    published_at: "2024-12-11T00:00:00Z",
    commission: { ...commissions[1], jurisdiction: jurisdictions[1] },
  },
  {
    id: "30000000-0000-4000-8000-000000000004",
    commission_id: "20000000-0000-4000-8000-000000000003",
    date: "2024-12-12",
    time: "14:00",
    location: "Austin City Hall, Council Chambers",
    status: "cancelled",
    agenda_url: null,
    minutes_url: null,
    created_at: "2024-12-01T00:00:00Z",
    updated_at: "2024-12-10T00:00:00Z",
    published_at: "2024-12-10T00:00:00Z",
    commission: { ...commissions[2], jurisdiction: jurisdictions[2] },
  },
  {
    id: "30000000-0000-4000-8000-000000000005",
    commission_id: "20000000-0000-4000-8000-000000000002",
    date: "2025-01-07",
    time: "09:30",
    location: "Boulder County Courthouse",
    status: "scheduled",
    agenda_url: null,
    minutes_url: null,
    created_at: "2024-12-15T00:00:00Z",
    updated_at: "2024-12-15T00:00:00Z",
    published_at: "2024-12-15T00:00:00Z",
    commission: { ...commissions[1], jurisdiction: jurisdictions[1] },
  },
];

export const agendaItems: AgendaItem[] = [
  {
    id: "40000000-0000-4000-8000-000000000001",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    item_number: 1,
    title: "Call to Order and Roll Call",
    description: null,
    category: "procedural",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-11-20T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000002",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    item_number: 2,
    title: "Rezoning Application: 1234 Main St",
    description:
      "Request to rezone from R-2 to MU-3 for mixed-use development. Applicant proposes 120-unit residential with ground-floor retail.",
    category: "zoning",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-11-20T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000003",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    item_number: 3,
    title: "Site Plan Review: Riverside Commerce Park",
    description:
      "Review of site plan for 50,000 sqft commercial development at Riverside Dr and 5th Ave.",
    category: "development",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-11-20T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000004",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    item_number: 4,
    title: "Public Comment Period",
    description: null,
    category: "procedural",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-11-20T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000005",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    item_number: 5,
    title: "Adjournment",
    description: null,
    category: "procedural",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-11-20T00:00:00Z",
    updated_at: "2024-11-20T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000006",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    item_number: 1,
    title: "Approval of Minutes",
    description: "Approval of minutes from November 26, 2024 meeting",
    category: "procedural",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-12-01T00:00:00Z",
    updated_at: "2024-12-01T00:00:00Z",
  },
  {
    id: "40000000-0000-4000-8000-000000000007",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    item_number: 2,
    title: "Land Use Change: Niwot Rural Area",
    description:
      "Consideration of land use designation change from Agricultural to Rural Residential for 45-acre parcel.",
    category: "land-use",
    // No mark: the fixture asserts nothing about how the text was extracted.
    field_confidence: {},
    created_at: "2024-12-01T00:00:00Z",
    updated_at: "2024-12-01T00:00:00Z",
  },
];

export const meetingDocuments: MeetingDocument[] = [
  {
    id: "50000000-0000-4000-8000-000000000001",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    title: "Staff Report - 1234 Main St Rezoning",
    document_type: "staff_report",
    url: "https://example.com/doc1.pdf",
    created_at: "2024-11-25T00:00:00Z",
    updated_at: "2024-11-25T00:00:00Z",
  },
  {
    id: "50000000-0000-4000-8000-000000000002",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    title: "Site Plan - Riverside Commerce Park",
    document_type: "site_plan",
    url: "https://example.com/doc2.pdf",
    created_at: "2024-11-25T00:00:00Z",
    updated_at: "2024-11-25T00:00:00Z",
  },
];

/**
 * `source` and `metadata` are not independent in the real API:
 *
 *   - the detector (`detectAnomalies`) inserts `{...flag, source: "auto"}` and
 *     never supplies `metadata`, so an auto row always has `metadata: null`;
 *   - `POST /api/anomalies` hardcodes `source: "manual"` and is the only writer
 *     that can persist a `metadata` object.
 *
 * So `source: "auto"` with non-null `metadata` is unreachable and must not
 * appear here. Each flag below is therefore attributed to the path that could
 * actually have produced it, severity included — the auto rules hardcode
 * `critical` for quorum_issue, whereas the manual route accepts any severity.
 */
export const anomalyFlags: AnomalyFlag[] = [
  {
    id: "60000000-0000-4000-8000-000000000001",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000002",
    flag_type: "last_minute_agenda_change",
    description: "Agenda item 2 (1234 Main St Rezoning) was added less than 24 hours before the meeting.",
    severity: "high",
    metadata: { hours_before_meeting: 18 },
    source: "manual",
    created_at: "2024-12-03T10:00:00Z",
  },
  {
    id: "60000000-0000-4000-8000-000000000002",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    agenda_item_id: null,
    flag_type: "quorum_issue",
    description: "Only 2 of 5 board members were present. Meeting proceeded without formal quorum.",
    severity: "critical",
    metadata: null,
    source: "auto",
    created_at: "2024-12-10T10:00:00Z",
  },
  {
    id: "60000000-0000-4000-8000-000000000003",
    meeting_id: "30000000-0000-4000-8000-000000000004",
    agenda_item_id: null,
    flag_type: "missing_minutes",
    description: "Meeting was cancelled but no official notice or minutes of cancellation were filed.",
    severity: "medium",
    metadata: null,
    source: "manual",
    created_at: "2024-12-12T10:00:00Z",
  },
  {
    id: "60000000-0000-4000-8000-000000000004",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000003",
    flag_type: "unanimous_controversial",
    description: "Riverside Commerce Park site plan passed unanimously despite significant public opposition.",
    severity: "medium",
    metadata: { vote_count: 3, dissenting: 0 },
    source: "manual",
    created_at: "2024-12-04T08:00:00Z",
  },
];

/**
 * `term_start` / `term_end` are Postgres `date` columns. node-pg parses OID
 * 1082 into a JS `Date`, which `res.json()` serializes as a full ISO 8601
 * timestamp — never a bare "YYYY-MM-DD". The fixtures mirror that.
 */
export const members: Member[] = [
  {
    id: "80000000-0000-4000-8000-000000000001",
    jurisdiction_id: "10000000-0000-4000-8000-000000000001",
    name: "Sarah Chen",
    title: "Chair",
    email: "schen@example.invalid",
    term_start: "2023-01-15T00:00:00.000Z",
    term_end: "2027-01-15T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    jurisdiction: jurisdictions[0],
  },
  {
    id: "80000000-0000-4000-8000-000000000002",
    jurisdiction_id: "10000000-0000-4000-8000-000000000001",
    name: "Marcus Thompson",
    title: "Vice Chair",
    email: "mthompson@example.invalid",
    term_start: "2022-06-01T00:00:00.000Z",
    term_end: "2026-06-01T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    jurisdiction: jurisdictions[0],
  },
  {
    id: "80000000-0000-4000-8000-000000000003",
    jurisdiction_id: "10000000-0000-4000-8000-000000000001",
    name: "Lisa Park",
    title: "Commissioner",
    email: "lpark@example.invalid",
    term_start: "2024-01-01T00:00:00.000Z",
    term_end: "2028-01-01T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    jurisdiction: jurisdictions[0],
  },
  {
    id: "80000000-0000-4000-8000-000000000004",
    jurisdiction_id: "10000000-0000-4000-8000-000000000002",
    name: "James Rodriguez",
    title: "Commissioner",
    email: "jrodriguez@example.invalid",
    term_start: "2023-03-01T00:00:00.000Z",
    term_end: "2027-03-01T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    jurisdiction: jurisdictions[1],
  },
  {
    id: "80000000-0000-4000-8000-000000000005",
    jurisdiction_id: "10000000-0000-4000-8000-000000000002",
    name: "Emily Watson",
    title: "Commissioner",
    email: "ewatson@example.invalid",
    term_start: "2022-01-01T00:00:00.000Z",
    term_end: "2026-01-01T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    jurisdiction: jurisdictions[1],
  },
];

export const votes: Vote[] = [
  {
    id: "90000000-0000-4000-8000-000000000001",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000002",
    member_id: "80000000-0000-4000-8000-000000000001",
    vote: "yes",
    created_at: "2024-12-03T18:30:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000002",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000002",
    member_id: "80000000-0000-4000-8000-000000000002",
    vote: "yes",
    created_at: "2024-12-03T18:30:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000003",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000002",
    member_id: "80000000-0000-4000-8000-000000000003",
    vote: "no",
    created_at: "2024-12-03T18:30:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000004",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000003",
    member_id: "80000000-0000-4000-8000-000000000001",
    vote: "yes",
    created_at: "2024-12-03T19:00:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000005",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000003",
    member_id: "80000000-0000-4000-8000-000000000002",
    vote: "yes",
    created_at: "2024-12-03T19:00:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000006",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    agenda_item_id: "40000000-0000-4000-8000-000000000003",
    member_id: "80000000-0000-4000-8000-000000000003",
    vote: "yes",
    created_at: "2024-12-03T19:00:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000007",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    agenda_item_id: "40000000-0000-4000-8000-000000000007",
    member_id: "80000000-0000-4000-8000-000000000004",
    vote: "yes",
    created_at: "2024-12-10T10:00:00Z",
  },
  {
    id: "90000000-0000-4000-8000-000000000008",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    agenda_item_id: "40000000-0000-4000-8000-000000000007",
    member_id: "80000000-0000-4000-8000-000000000005",
    vote: "abstain",
    created_at: "2024-12-10T10:00:00Z",
  },
];

/**
 * Matters. `axxxxxxx…` — see the id convention above.
 *
 * Three fixtures, chosen to exercise the three things the pages have to get
 * right rather than to look plausible: one designator-matched matter that
 * spans three meetings (the whole point of the feature), one title-matched
 * matter with a single appearance, and one dormant matter, which is the state
 * no other page in this product can show.
 */
export const matters: Matter[] = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    title: "Rezoning of 1234 Main St from R-2 to MU-3",
    designator: "Ordinance 2145",
    state: "pending",
    first_seen: "2024-11-06",
    last_seen: "2024-12-04",
    appearance_count: 3,
    jurisdiction_name: "City of Bozeman",
    commission_name: "City Commission",
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    title: "Riverside Commerce Park site plan",
    designator: null,
    state: "decided",
    first_seen: "2024-12-04",
    last_seen: "2024-12-04",
    appearance_count: 1,
    jurisdiction_name: "City of Bozeman",
    commission_name: "City Commission",
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    title: "Niwot rural area land use change",
    designator: "Application Z-2023-041",
    state: "dormant",
    first_seen: "2023-04-18",
    last_seen: "2023-06-20",
    appearance_count: 2,
    jurisdiction_name: "Gallatin County",
    commission_name: "County Commission",
  },
];

export const matterAppearances: Record<string, MatterAppearance[]> = {
  "a0000000-0000-4000-8000-000000000001": [
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000a1",
      meeting_id: "30000000-0000-4000-8000-000000000001",
      meeting_date: "2024-11-06",
      item_number: 7,
      title: "Ordinance 2145 — rezoning of 1234 Main St, first reading",
      match_rule: "designator",
    },
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000a2",
      meeting_id: "30000000-0000-4000-8000-000000000002",
      meeting_date: "2024-11-20",
      item_number: 4,
      // Deliberately renamed between readings. The detail page shows the title
      // as printed at each meeting rather than normalising it away, and this
      // fixture is what proves it.
      title: "Ordinance 2145 — Main St rezone, continued from 6 November",
      match_rule: "designator",
    },
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000a3",
      meeting_id: "30000000-0000-4000-8000-000000000003",
      meeting_date: "2024-12-04",
      item_number: 2,
      title: "Ordinance 2145 — rezoning of 1234 Main St, second reading",
      match_rule: "designator",
    },
  ],
  "a0000000-0000-4000-8000-000000000002": [
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000b1",
      meeting_id: "30000000-0000-4000-8000-000000000003",
      meeting_date: "2024-12-04",
      item_number: 5,
      title: "Riverside Commerce Park site plan",
      match_rule: "normalized_title",
    },
  ],
  "a0000000-0000-4000-8000-000000000003": [
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000c1",
      meeting_id: "30000000-0000-4000-8000-000000000004",
      meeting_date: "2023-04-18",
      item_number: 3,
      title: "Application Z-2023-041 — Niwot rural area land use change",
      match_rule: "designator",
    },
    {
      agenda_item_id: "40000000-0000-4000-8000-0000000000c2",
      meeting_id: "30000000-0000-4000-8000-000000000004",
      meeting_date: "2023-06-20",
      item_number: 6,
      title: "Application Z-2023-041 — Niwot land use change, continued",
      match_rule: "designator",
    },
  ],
};

/**
 * Metrics. Chosen so the page's two hard cases are exercised by the default
 * fixture: a published count well below the total (the gap is the point), and
 * a documents-indexed count below documents-total (a scan that could not be
 * read is held but not searchable).
 */
export const metrics: Metrics = {
  corpus: {
    meetings_total: 37,
    meetings_published: 12,
    agenda_items: 214,
    documents_indexed: 48,
    documents_total: 61,
    votes: 96,
    matters: 19,
  },
  review: {
    findings_total: 14,
    findings_published: 9,
    findings_held: 5,
    claims_total: 63,
    claims_approved: 0,
    disputes_received: 2,
    disputes_resolved: 1,
  },
  latency: {
    median_days_to_publish: 6.5,
    last_published_at: "2024-12-05T17:02:00Z",
  },
  generated_at: "2024-12-06T09:00:00Z",
};
