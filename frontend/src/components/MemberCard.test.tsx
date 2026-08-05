import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemberCard, type MemberVotingRecord } from "./MemberCard";
import type { Member } from "@/types";

const member: Member = {
  id: "mem1",
  jurisdiction_id: "j1",
  name: "Sarah Chen",
  title: "Chair",
  email: "schen@denver.gov",
  term_start: "2023-01-15",
  term_end: "2027-01-15",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  jurisdiction: {
    id: "j1",
    name: "Denver",
    state: "CO",
    type: "city",
    website_url: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
};

const record: MemberVotingRecord = {
  yes: 6,
  no: 1,
  abstain: 2,
  absent: 3,
  total: 12,
};

describe("MemberCard", () => {
  it("renders the official's name as the row heading", () => {
    render(<MemberCard member={member} />);
    const heading = screen.getByRole("heading", { name: "Sarah Chen" });
    expect(heading).toBeInTheDocument();
  });

  it("names the roster row after the official", () => {
    render(<MemberCard member={member} />);
    expect(
      screen.getByRole("article", { name: "Sarah Chen" }),
    ).toBeInTheDocument();
  });

  it("renders title and jurisdiction on the office line", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("Chair · Denver, CO")).toBeInTheDocument();
  });

  it("renders the term as readable dates", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("Term")).toBeInTheDocument();
    expect(
      screen.getByText("Jan 15, 2023 – Jan 15, 2027"),
    ).toBeInTheDocument();
  });

  it("renders an open-ended term as running to the present", () => {
    render(<MemberCard member={{ ...member, term_end: null }} />);
    expect(screen.getByText("Jan 15, 2023 – Present")).toBeInTheDocument();
  });

  it("renders the email as a citation chip", () => {
    render(<MemberCard member={member} />);
    const link = screen.getByRole("link", { name: "schen@denver.gov" });
    expect(link).toHaveAttribute("href", "mailto:schen@denver.gov");
  });

  it("summarises the voting record in the vote_value vocabulary", () => {
    render(<MemberCard member={member} record={record} />);
    const row = screen.getByRole("article", { name: "Sarah Chen" });
    expect(within(row).getByText("12")).toBeInTheDocument();
    expect(within(row).getByText("votes recorded")).toBeInTheDocument();
    expect(
      within(row).getByText("6 yes · 1 no · 2 abstain · 3 absent"),
    ).toBeInTheDocument();
  });

  it("uses the singular when only one vote is on the record", () => {
    render(
      <MemberCard
        member={member}
        record={{ yes: 1, no: 0, abstain: 0, absent: 0, total: 1 }}
      />
    );
    expect(screen.getByText("vote recorded")).toBeInTheDocument();
  });

  it("says so when the official has no votes on the record", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("No recorded votes")).toBeInTheDocument();
  });

  it("never uses yea/nay vocabulary", () => {
    render(<MemberCard member={member} record={record} />);
    expect(screen.queryByText(/\b(yea|nay)s?\b/i)).toBeNull();
  });
});
