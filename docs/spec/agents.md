# CommissionWatch — Watchdog Agent Specifications

## Agent Design Principles

1. **Single responsibility** — each agent has one domain
2. **Zero-permission start** — no tool access until explicitly granted
3. **Idempotent runs** — safe to re-run without side effects
4. **Structured output** — every agent produces typed, queryable results
5. **Cross-referenceable** — agents' outputs link to shared entity IDs

## Agent Catalog

### Meeting Monitor Agent

**Purpose:** Track commission meetings and generate rundown sheets.

**Inputs:**
- Government meeting websites (agendas, minutes, video URLs)
- Historical meeting archives

**Outputs:**
- Quick Rundown Sheet (structured meeting summary)
- Flagged items (unusual patterns)
- Speaker identification + quote extraction

**Tools Required:**
- Web scraper (scoped to government sites)
- PDF parser
- Audio transcription (if video available)
- Database write (meetings table)

**Schedule:** After each commission meeting (configurable polling)

---

### Vote Tracker Agent

**Purpose:** Record and analyze voting patterns.

**Inputs:**
- Meeting minutes (from Meeting Monitor)
- Historical vote records

**Outputs:**
- Vote records per member per motion
- Voting pattern analysis (bloc detection, anomaly scores)
- Member scorecards

**Tools Required:**
- Database read (meetings, members)
- Database write (votes table)
- Analytics engine

**Schedule:** After Meeting Monitor completes

---

### Follow-the-Money Agent

**Purpose:** Trace campaign finance and flag conflicts of interest.

**Inputs:**
- OpenFEC API data
- State campaign finance portals
- Lobbying disclosures
- Vote records (from Vote Tracker)
- Contract/procurement records

**Outputs:**
- Donor-to-official relationship maps
- Conflict-of-interest flags
- Follow-the-money reports with visual trails
- Dark money pattern alerts

**Tools Required:**
- OpenFEC API client
- State finance API clients
- Database read/write (donations, contracts)
- Graph builder

**Schedule:** Weekly + triggered on new large donations

---

### Member Profiler Agent

**Purpose:** Maintain dossiers on commission members.

**Inputs:**
- Public records (financial disclosures, property records)
- Social media (public accounts only)
- Meeting transcripts (statements, positions)
- Vote history

**Outputs:**
- Member profile documents
- Position-vs-vote discrepancy alerts
- Business interest cross-references

**Tools Required:**
- Public records search
- Social media reader (public only)
- Database read/write (members table)

**Schedule:** Weekly refresh + triggered on profile changes

---

### Document Digger Agent

**Purpose:** Monitor and index public documents for anomalies.

**Inputs:**
- FOIA responses
- Permits and contracts
- Budget documents
- Public meeting packets

**Outputs:**
- Indexed document corpus (searchable via pgvector)
- Entity extractions (people, amounts, dates, organizations)
- Anomaly flags (no-bid contracts, budget spikes, fast-tracked permits)

**Tools Required:**
- OCR engine
- PDF/document parser
- Entity extraction
- Database write (documents table)
- Vector embedding writer

**Schedule:** Continuous polling of known document sources

---

### Alert & Briefing Agent

**Purpose:** Synthesize cross-agent findings into actionable briefings.

**Inputs:**
- All other agents' outputs
- User alert preferences
- Jurisdiction configuration

**Outputs:**
- Daily/weekly briefing documents
- Real-time alert feed
- Deep dive research reports (triggered by patterns)
- Dashboard data

**Tools Required:**
- Database read (all tables)
- Email sender
- Webhook dispatcher
- Report generator

**Schedule:** Daily briefing + real-time on high-priority flags
