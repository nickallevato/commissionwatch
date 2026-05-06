import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemberCard } from "./MemberCard";
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

describe("MemberCard", () => {
  it("renders member name and title", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("Sarah Chen")).toBeInTheDocument();
    expect(screen.getByText("Chair")).toBeInTheDocument();
  });

  it("renders jurisdiction info", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("Denver, CO")).toBeInTheDocument();
  });

  it("renders initials avatar", () => {
    render(<MemberCard member={member} />);
    expect(screen.getByText("SC")).toBeInTheDocument();
  });
});
