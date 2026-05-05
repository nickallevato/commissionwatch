import type { Signal, PipelineSegment, ComplianceItem } from "../types/hub";

export const STUB_SIGNALS: Signal[] = [
  {
    id: "s1",
    priority: "critical",
    title: "Inspection contingency expires in 3 days",
    description:
      "Buyer must respond by Friday or contingency is waived. Inspection report flagged 2 issues.",
    agent: "Domus",
    time: "2h ago",
    ctaLabel: "Draft response",
    ctaTarget: "/deals/d1/inspection",
  },
  {
    id: "s2",
    priority: "warn",
    title: "Lender appraisal received — $865K",
    description:
      "Appraisal came in $10K under contract. Options: renegotiate, buyer covers gap, or walk.",
    agent: "Domus",
    time: "4h ago",
    ctaLabel: "View options",
    ctaTarget: "/deals/d1/appraisal",
  },
  {
    id: "s3",
    priority: "info",
    title: "Buyer's agent replied re: closing date",
    description:
      "Sarah confirmed June 14 works. Suggests 10am closing at First American Title.",
    agent: "Deedus",
    time: "6h ago",
    ctaLabel: "Read thread",
    ctaTarget: "/deals/d1/messages",
  },
];

export const STUB_PIPELINE: PipelineSegment[] = [
  { label: "Listed", state: "done" },
  { label: "Offer", state: "done" },
  { label: "Inspection", state: "current" },
  { label: "Appraisal", state: "upcoming" },
  { label: "Closing", state: "upcoming" },
];

export const STUB_COMPLIANCE: ComplianceItem[] = [
  { id: "c1", label: "Property Disclosure Statement", done: true },
  { id: "c2", label: "Lead-Based Paint Disclosure", done: true },
  { id: "c3", label: "Wood Heat Disclosure", done: true },
  { id: "c4", label: "Mold Disclosure", done: false, dueDate: "May 12" },
  {
    id: "c5",
    label: "Methamphetamine Contamination",
    done: false,
    dueDate: "May 15",
  },
];
