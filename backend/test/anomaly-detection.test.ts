import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkEmergencySession,
  checkMissingMinutes,
  checkQuorumIssue,
  checkLastMinuteAgendaChange,
  checkUnanimousControversial,
  checkClosedDoorVote,
  RULES_VERSION,
} from "../src/services/anomaly-detection";

function makeMeeting(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    commission_id: "c-1",
    date: "2025-01-15",
    time: "18:00",
    status: "completed",
    agenda_url: "https://example.com/agenda.pdf",
    minutes_url: "https://example.com/minutes.pdf",
    created_at: "2025-01-10T00:00:00Z",
    updated_at: "2025-01-10T00:00:00Z",
    ...overrides,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockKnex(tableData: Record<string, unknown[]>): any {
  function buildChain(tableName: string, filters: Record<string, unknown>[] = []): any {
    const chain: any = {};
    let selectCols: string[] = [];
    let countCol: string | null = null;
    let distinctCountCol: string | null = null;
    let whereNotFilters: Record<string, unknown>[] = [];
    let whereInClauses: Array<{ col: string; values: unknown[] }> = [];

    function getFiltered() {
      let rows = [...(tableData[tableName] || [])];
      for (const f of filters) {
        rows = rows.filter((r) =>
          Object.entries(f).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        );
      }
      for (const f of whereNotFilters) {
        rows = rows.filter((r) =>
          Object.entries(f).some(([k, v]) => (r as Record<string, unknown>)[k] !== v),
        );
      }
      for (const wc of whereInClauses) {
        rows = rows.filter((r) => wc.values.includes((r as Record<string, unknown>)[wc.col]));
      }
      return rows;
    }

    chain.where = (...args: unknown[]) => {
      if (typeof args[0] === "function") {
        const subBuilder = {
          _orClauses: [] as Array<{ col: string; op: string; val: unknown }>,
          whereNull(col: string) {
            this._orClauses.push({ col, op: "null", val: null });
            return this;
          },
          orWhere(col: string, op: string, val: unknown) {
            this._orClauses.push({ col, op, val });
            return this;
          },
        };
        (args[0] as (this: typeof subBuilder) => void).call(subBuilder);
        return chain;
      }
      if (typeof args[0] === "object") {
        filters.push(args[0] as Record<string, unknown>);
      } else if (args.length === 3) {
        // where(col, op, val) — used for date comparisons etc.
      }
      return chain;
    };
    chain.whereNot = (...args: unknown[]) => {
      if (typeof args[0] === "object") {
        whereNotFilters.push(args[0] as Record<string, unknown>);
      }
      return chain;
    };
    chain.whereIn = (col: unknown, vals: unknown) => {
      if (Array.isArray(vals)) {
        whereInClauses.push({ col: col as string, values: vals });
      }
      return chain;
    };
    chain.whereNull = () => chain;
    chain.orWhere = () => chain;
    chain.select = (...cols: unknown[]) => {
      selectCols = cols.flat() as string[];
      return chain;
    };
    chain.count = (expr: unknown) => {
      countCol = (expr as string).replace(" as ", ":");
      return chain;
    };
    chain.countDistinct = (expr: unknown) => {
      distinctCountCol = (expr as string).replace(" as ", ":");
      return chain;
    };
    chain.first = (): any => {
      const rows = getFiltered();
      const row = rows[0] || null;
      if (!row) return Promise.resolve(null);
      if (countCol) {
        const alias = countCol.split(":")[1] || "count";
        return Promise.resolve({ [alias]: rows.length });
      }
      if (distinctCountCol) {
        const alias = distinctCountCol.split(":")[1] || "count";
        const col = distinctCountCol.split(":")[0].replace("*", "id");
        const unique = new Set(rows.map((r) => (r as Record<string, unknown>)[col]));
        return Promise.resolve({ [alias]: unique.size });
      }
      return Promise.resolve(row);
    };

    chain.then = (resolve: (v: unknown) => void) => {
      const rows = getFiltered();
      if (countCol) {
        const alias = countCol.split(":")[1] || "count";
        resolve([{ [alias]: rows.length }]);
      } else if (distinctCountCol) {
        const alias = distinctCountCol.split(":")[1] || "count";
        resolve([{ [alias]: rows.length }]);
      } else if (selectCols.length > 0) {
        resolve(
          rows.map((r) => {
            const rec = r as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const c of selectCols) out[c] = rec[c];
            return out;
          }),
        );
      } else {
        resolve(rows);
      }
    };

    return chain;
  }

  const knex = (tableName: string) => buildChain(tableName);
  return knex;
}

describe("RULES_VERSION", () => {
  it("exports a semver version string", () => {
    assert.match(RULES_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

describe("checkEmergencySession", () => {
  it("flags emergency meetings", async () => {
    const meeting = makeMeeting({ status: "emergency" });
    const result = await checkEmergencySession(mockKnex({}) as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.flag_type, "emergency_session");
    assert.equal(result!.severity, "high");
  });

  it("flags special meetings", async () => {
    const meeting = makeMeeting({ status: "special" });
    const result = await checkEmergencySession(mockKnex({}) as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.flag_type, "emergency_session");
  });

  it("does not flag regular meetings", async () => {
    const meeting = makeMeeting({ status: "completed" });
    const result = await checkEmergencySession(mockKnex({}) as never, meeting as never);
    assert.equal(result, null);
  });
});

describe("checkMissingMinutes", () => {
  it("flags meetings older than 14 days without minutes", async () => {
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const meeting = makeMeeting({ date: oldDate, minutes_url: null });
    const result = await checkMissingMinutes(mockKnex({}) as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.flag_type, "missing_minutes");
    assert.equal(result!.severity, "medium");
  });

  it("escalates severity past 30 days", async () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const meeting = makeMeeting({ date: oldDate, minutes_url: null });
    const result = await checkMissingMinutes(mockKnex({}) as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.severity, "high");
  });

  it("escalates severity past 90 days", async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const meeting = makeMeeting({ date: oldDate, minutes_url: null });
    const result = await checkMissingMinutes(mockKnex({}) as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.severity, "critical");
  });

  it("does not flag meetings with minutes", async () => {
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const meeting = makeMeeting({ date: oldDate, minutes_url: "https://example.com/minutes.pdf" });
    const result = await checkMissingMinutes(mockKnex({}) as never, meeting as never);
    assert.equal(result, null);
  });

  it("does not flag recent meetings", async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const meeting = makeMeeting({ date: recentDate, minutes_url: null });
    const result = await checkMissingMinutes(mockKnex({}) as never, meeting as never);
    assert.equal(result, null);
  });
});

describe("checkQuorumIssue", () => {
  it("flags when present members are below quorum", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      members: [
        { id: "mem-1", jurisdiction_id: "j-1" },
        { id: "mem-2", jurisdiction_id: "j-1" },
        { id: "mem-3", jurisdiction_id: "j-1" },
        { id: "mem-4", jurisdiction_id: "j-1" },
        { id: "mem-5", jurisdiction_id: "j-1" },
      ],
      votes: [
        { meeting_id: "m-1", member_id: "mem-1", vote: "yes" },
        { meeting_id: "m-1", member_id: "mem-2", vote: "yes" },
      ],
      commissions: [{ id: "c-1", jurisdiction_id: "j-1" }],
    });
    const result = await checkQuorumIssue(db as never, meeting as never);
    assert.ok(result);
    assert.equal(result!.flag_type, "quorum_issue");
    assert.equal(result!.severity, "critical");
  });

  it("uses correct quorum formula floor(n/2)+1", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      members: [
        { id: "mem-1", jurisdiction_id: "j-1" },
        { id: "mem-2", jurisdiction_id: "j-1" },
        { id: "mem-3", jurisdiction_id: "j-1" },
        { id: "mem-4", jurisdiction_id: "j-1" },
        { id: "mem-5", jurisdiction_id: "j-1" },
      ],
      votes: [
        { meeting_id: "m-1", member_id: "mem-1", vote: "yes" },
        { meeting_id: "m-1", member_id: "mem-2", vote: "yes" },
        { meeting_id: "m-1", member_id: "mem-3", vote: "yes" },
      ],
      commissions: [{ id: "c-1", jurisdiction_id: "j-1" }],
    });
    const result = await checkQuorumIssue(db as never, meeting as never);
    assert.equal(result, null, "3 of 5 meets quorum (floor(5/2)+1 = 3)");
  });

  it("returns null when no members exist", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({ members: [], votes: [], commissions: [] });
    const result = await checkQuorumIssue(db as never, meeting as never);
    assert.equal(result, null);
  });
});

describe("checkLastMinuteAgendaChange", () => {
  it("flags items added less than 24h before meeting", async () => {
    const meetingDate = "2025-01-15";
    const meeting = makeMeeting({ date: meetingDate });
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Late item",
          created_at: "2025-01-14T20:00:00Z",
        },
      ],
    });
    const result = await checkLastMinuteAgendaChange(db as never, meeting as never);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].flag_type, "last_minute_agenda_change");
    assert.equal(result[0].agenda_item_id, "ai-1");
    assert.ok(result[0].description.includes("Late item"));
  });

  it("flags multiple late items individually", async () => {
    const meeting = makeMeeting({ date: "2025-01-15" });
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Late 1", created_at: "2025-01-14T20:00:00Z" },
        { id: "ai-2", meeting_id: "m-1", title: "Late 2", created_at: "2025-01-14T23:00:00Z" },
      ],
    });
    const result = await checkLastMinuteAgendaChange(db as never, meeting as never);
    assert.equal(result.length, 2);
  });

  it("does not flag items added well before meeting", async () => {
    const meeting = makeMeeting({ date: "2025-01-15" });
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Early item", created_at: "2025-01-10T10:00:00Z" },
      ],
    });
    const result = await checkLastMinuteAgendaChange(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("returns empty array for meetings with no agenda items", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({ agenda_items: [] });
    const result = await checkLastMinuteAgendaChange(db as never, meeting as never);
    assert.equal(result.length, 0);
  });
});

describe("checkUnanimousControversial", () => {
  it("flags unanimous votes on controversial items", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Rezone parcel", category: "zoning" },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-3", vote: "yes" },
      ],
    });
    const result = await checkUnanimousControversial(db as never, meeting as never);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].flag_type, "unanimous_controversial");
    assert.equal(result[0].agenda_item_id, "ai-1");
    assert.equal(result[0].severity, "low");
  });

  it("flags each unanimous controversial item separately", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Budget item", category: "budget" },
        { id: "ai-2", meeting_id: "m-1", title: "Zoning item", category: "zoning" },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-3", vote: "yes" },
        { agenda_item_id: "ai-2", member_id: "mem-1", vote: "no" },
        { agenda_item_id: "ai-2", member_id: "mem-2", vote: "no" },
        { agenda_item_id: "ai-2", member_id: "mem-3", vote: "no" },
      ],
    });
    const result = await checkUnanimousControversial(db as never, meeting as never);
    assert.equal(result.length, 2);
  });

  it("does not flag non-controversial categories", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Consent item", category: "consent" },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-3", vote: "yes" },
      ],
    });
    const result = await checkUnanimousControversial(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("does not flag split votes", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Budget item", category: "budget" },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "no" },
        { agenda_item_id: "ai-1", member_id: "mem-3", vote: "yes" },
      ],
    });
    const result = await checkUnanimousControversial(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("does not flag items with fewer than 3 non-absent votes", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        { id: "ai-1", meeting_id: "m-1", title: "Budget item", category: "budget" },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
      ],
    });
    const result = await checkUnanimousControversial(db as never, meeting as never);
    assert.equal(result.length, 0);
  });
});

describe("checkClosedDoorVote", () => {
  it("flags votes on executive session items", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Personnel discussion",
          description: null,
          category: "executive_session",
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].flag_type, "closed_door_vote");
    assert.equal(result[0].severity, "high");
    assert.equal(result[0].agenda_item_id, "ai-1");
  });

  it("detects executive session from title", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Executive Session - Legal Matters",
          description: null,
          category: "other",
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 1);
  });

  it("detects closed session from description", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Item 5",
          description: "Discussion in closed session regarding personnel",
          category: null,
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 1);
  });

  it("excludes procedural motions to enter/exit executive session", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Motion to enter executive session",
          description: null,
          category: "executive_session",
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
        { agenda_item_id: "ai-1", member_id: "mem-2", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("excludes motion to return from executive session", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Motion to return from executive session",
          description: null,
          category: "executive_session",
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("does not flag executive session items with no votes", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Executive Session discussion",
          description: null,
          category: "executive_session",
        },
      ],
      votes: [],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 0);
  });

  it("does not flag non-executive session items", async () => {
    const meeting = makeMeeting();
    const db = mockKnex({
      agenda_items: [
        {
          id: "ai-1",
          meeting_id: "m-1",
          title: "Regular business",
          description: null,
          category: "general",
        },
      ],
      votes: [
        { agenda_item_id: "ai-1", member_id: "mem-1", vote: "yes" },
      ],
    });
    const result = await checkClosedDoorVote(db as never, meeting as never);
    assert.equal(result.length, 0);
  });
});
