import type {
  Jurisdiction,
  Commission,
  Meeting,
  AgendaItem,
  MeetingDocument,
  RundownSheet,
  Member,
  Vote,
  AnomalyFlag,
} from "@/types";

/**
 * Every `id` and foreign key below is a real UUID, because every corresponding
 * column is `uuid` and the API routes reject anything that fails
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` with 400.
 *
 * They follow a readable convention so cross-references stay auditable:
 *   1xxxxxxx… jurisdictions   6xxxxxxx… anomaly flags
 *   2xxxxxxx… commissions     7xxxxxxx… rundown sheets
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
    website_url: "https://denver.gov",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    name: "Boulder County",
    state: "CO",
    type: "county",
    website_url: "https://bouldercounty.gov",
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

export const rundownSheets: RundownSheet[] = [
  {
    id: "70000000-0000-4000-8000-000000000001",
    meeting_id: "30000000-0000-4000-8000-000000000001",
    summary:
      "Key meeting focused on a significant rezoning request at 1234 Main St that would allow mixed-use development. The site plan for Riverside Commerce Park was also reviewed. Both items drew considerable public interest.",
    key_items: [
      {
        title: "1234 Main St Rezoning",
        description:
          "Major rezoning from R-2 to MU-3 for 120-unit mixed-use. Staff recommends approval with conditions. Notable public opposition from adjacent neighborhood.",
        category: "zoning",
        priority: "high",
      },
      {
        title: "Riverside Commerce Park",
        description:
          "50,000 sqft commercial site plan. Traffic study shows acceptable LOS. Landscaping plan meets code requirements.",
        category: "development",
        priority: "medium",
      },
    ],
    generated_at: "2024-12-04T10:00:00Z",
    created_at: "2024-12-04T10:00:00Z",
    updated_at: "2024-12-04T10:00:00Z",
  },
  {
    id: "70000000-0000-4000-8000-000000000002",
    meeting_id: "30000000-0000-4000-8000-000000000003",
    summary:
      "Routine meeting with one significant land use change application for the Niwot rural area. The proposal would affect 45 acres of currently agricultural land.",
    key_items: [
      {
        title: "Niwot Rural Area Land Use Change",
        description:
          "45-acre agricultural to rural residential conversion. Water rights and access road concerns raised by neighbors.",
        category: "land-use",
        priority: "high",
      },
    ],
    generated_at: "2024-12-11T10:00:00Z",
    created_at: "2024-12-11T10:00:00Z",
    updated_at: "2024-12-11T10:00:00Z",
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
    email: "schen@denver.gov",
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
    email: "mthompson@denver.gov",
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
    email: "lpark@denver.gov",
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
    email: "jrodriguez@bouldercounty.gov",
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
    email: "ewatson@bouldercounty.gov",
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
