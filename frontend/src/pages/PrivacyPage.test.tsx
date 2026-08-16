import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PrivacyPage } from "./PrivacyPage";

/**
 * The privacy page makes factual claims about what the code does, and a page
 * like that decays the moment the code moves. These tests pin the claims that
 * would be actively misleading if they stopped being true, so that changing the
 * behaviour breaks the suite rather than quietly turning this page into a lie.
 *
 * They deliberately do not test prose. They test the four commitments a reader
 * would rely on, and the one admission that keeps the page honest.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
}

describe("PrivacyPage", () => {
  it("renders as a page, with an h1", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: /privacy and data handling/i }),
    ).toBeInTheDocument();
  });

  it("states that no IP address is stored against a dispute", () => {
    renderPage();
    expect(screen.getByText(/No IP address and no browser information/i)).toBeInTheDocument();
  });

  it("states that donor addresses were dropped from storage, not merely hidden", () => {
    renderPage();
    expect(
      screen.getByText(/removed the address columns from the database entirely/i),
    ).toBeInTheDocument();
  });

  it("states that search is not logged beyond aggregate counts", () => {
    renderPage();
    expect(screen.getByText(/deliberately unlogged beyond aggregate counts/i)).toBeInTheDocument();
  });

  /**
   * The load-bearing admission. `record_corrections` is enforced immutable by
   * a database trigger (migration 031) — this assertion is what stops that
   * claim being quietly softened into something implying a deletion path that
   * must never exist.
   */
  it("states that the corrections ledger can never be deleted, and why", () => {
    renderPage();
    expect(screen.getAllByText(/can never be deleted at all/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/forbids anyone — including us — from editing or deleting/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a corrections record that could quietly be changed would be worth nothing/i),
    ).toBeInTheDocument();
  });

  it("states that a subscriber channel is disabled on unsubscribe, not deleted", () => {
    renderPage();
    expect(
      screen.getByText(/disabled, not deleted, when you unsubscribe/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/switched off, rather than being erased/i)).toBeInTheDocument();
  });

  it("states there is no self-serve deletion for a dispute contact, only a written request", () => {
    renderPage();
    expect(
      screen.getByText(/kept until you ask us to remove it/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no self-serve deletion button today/i)).toBeInTheDocument();
  });

  it("names the retention gaps that are a decision but not yet built, without implying they exist", () => {
    renderPage();
    expect(
      screen.getByText(/stated intention, not a running system/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/time limit after which an unsubscribed contact's saved address/i),
    ).toBeInTheDocument();
  });

  /**
   * `sweepExpiredSessions()` was wired into a daily scheduler on 2026-08-16
   * (`52cfd60`, `backend/src/services/auth/session-sweep.ts`). This page must
   * say it runs, not that it is merely planned — a privacy page that
   * understates what the project does about personal data is still wrong
   * about personal data.
   */
  it("states that the operator session sweep now runs, not that it is only planned", () => {
    renderPage();
    expect(
      screen.getByText(/housekeeping job now clears out old operator sign-in records/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/removes any session row past its absolute expiry/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/housekeeping job that would clear out old operator sign-in records/i),
    ).not.toBeInTheDocument();
  });

  it("does not cite the test-fixture correction row count as if it were production", () => {
    renderPage();
    expect(screen.queryByText(/14,?528/)).not.toBeInTheDocument();
  });

  it("offers a route to have a dispute contact removed", () => {
    renderPage();
    const mailto = screen.getAllByRole("link", { name: /corrections@commissionwatch/i });
    expect(mailto.length).toBeGreaterThan(0);
  });

  it("links to the dispute form rather than only describing it", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /contest it/i })).toHaveAttribute(
      "href",
      "/corrections/dispute",
    );
  });
});
