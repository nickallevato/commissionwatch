export type SignalPriority = "critical" | "warn" | "info";

export interface Signal {
  id: string;
  priority: SignalPriority;
  title: string;
  description: string;
  agent: string;
  time: string;
  ctaLabel: string;
  ctaTarget: string;
}

export type PipelineStage = "Listed" | "Offer" | "Inspection" | "Appraisal" | "Closing";

export type StageState = "done" | "current" | "upcoming";

export interface PipelineSegment {
  label: PipelineStage;
  state: StageState;
}

export interface ComplianceItem {
  id: string;
  label: string;
  done: boolean;
  dueDate?: string;
}
