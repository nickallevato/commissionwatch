import { ProactivePanel } from "../components/ProactivePanel";
import { PipelineTimeline } from "../components/PipelineTimeline";
import { ComplianceChecklist } from "../components/ComplianceChecklist";
import { useSignals, usePipeline, useCompliance } from "../hooks/useHubData";
import {
  STUB_SIGNALS,
  STUB_PIPELINE,
  STUB_COMPLIANCE,
} from "../lib/hub-stubs";

const DEAL_ID = "d1";

export function HubPage() {
  const signalsQuery = useSignals(DEAL_ID);
  const pipelineQuery = usePipeline(DEAL_ID);
  const complianceQuery = useCompliance(DEAL_ID);

  const signals = signalsQuery.data ?? STUB_SIGNALS;
  const pipeline = pipelineQuery.data ?? STUB_PIPELINE;
  const compliance = complianceQuery.data ?? STUB_COMPLIANCE;

  return (
    <div className="min-h-screen bg-[#0a0b0e] text-gray-100">
      <div className="max-w-[1480px] mx-auto px-6 py-6">
        <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-4 min-h-[600px]">
          {/* Proactive signals — left column */}
          <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col">
            <ProactivePanel signals={signals} />
          </div>

          {/* Center column — pipeline + compliance */}
          <div className="flex flex-col gap-4">
            <PipelineTimeline segments={pipeline} closeDate="Jun 14, 2026" />
            <ComplianceChecklist items={compliance} />
          </div>

          {/* Right column — placeholder for property/parties (Sprint 3) */}
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4 text-center text-xs text-gray-500">
              Property &amp; Parties panels
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
