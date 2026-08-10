import { useState } from "react";

import { ModelSelectionMenu } from "./components/SessionToolbar.tsx";
import type { HarnessInfo } from "./harness-list.ts";
import { getModelCapability } from "./model-meta.ts";
import type { ThinkingConfig } from "./types.ts";

export type MinionTier = "mechanical" | "standard" | "reasoning";

const TIER_DETAILS: ReadonlyArray<{
  id: MinionTier;
  label: string;
  description: string;
}> = [
  { id: "mechanical", label: "Mechanical", description: "Fast, low-ambiguity work." },
  { id: "standard", label: "Standard", description: "General implementation and investigation." },
  { id: "reasoning", label: "Reasoning", description: "Tricky or ambiguous work." },
];

interface MinionSelection {
  model: string;
}

interface MinionModelRoutingSettingsProps {
  adaptive: boolean;
  activeHarnessName: string;
  activeHarness: HarnessInfo | undefined;
  harnesses: ReadonlyArray<HarnessInfo>;
  modelOptions: string[];
  modelLabels: Record<string, string>;
  selections: Record<MinionTier, MinionSelection>;
  thinkingConfig: ThinkingConfig;
  onAdaptiveChange: (adaptive: boolean) => void;
  onTierModelChange: (tier: MinionTier, model: string) => void;
  onHarnessChange: (harness: string, defaultModel?: string) => void;
  onThinkingConfigChange: (config: ThinkingConfig) => void;
}

export function MinionModelRoutingSettings({
  adaptive,
  activeHarnessName,
  activeHarness,
  harnesses,
  modelOptions,
  modelLabels,
  selections,
  thinkingConfig,
  onAdaptiveChange,
  onTierModelChange,
  onHarnessChange,
  onThinkingConfigChange,
}: MinionModelRoutingSettingsProps) {
  const [activeTier, setActiveTier] = useState<MinionTier>("standard");
  const visibleTier = adaptive ? activeTier : "standard";
  const detail = TIER_DETAILS.find((tier) => tier.id === visibleTier)!;
  const selection = selections[visibleTier];

  return (
    <div className="settings-minion-routing">
      <label className="settings-toggle settings-minion-routing__toggle">
        <span>
          <strong>Adaptive tier routing</strong>
          <small>
            {adaptive
              ? "Match delegated work to the configured capability tier."
              : "Keep every Minion on one rigid model definition."}
          </small>
        </span>
        <input
          type="checkbox"
          checked={adaptive}
          onChange={(event) => onAdaptiveChange(event.target.checked)}
        />
        <span className="settings-toggle__track" aria-hidden="true"><span /></span>
      </label>

      {adaptive ? (
        <div className="settings-tier-routing">
          <div className="settings-tier-tabs" role="tablist" aria-label="Minion assignment tiers">
            {TIER_DETAILS.map((tier) => (
              <button
                key={tier.id}
                id={`minion-tier-tab-${tier.id}`}
                type="button"
                role="tab"
                aria-selected={activeTier === tier.id}
                aria-controls={`minion-tier-panel-${tier.id}`}
                data-active={activeTier === tier.id}
                onClick={() => setActiveTier(tier.id)}
              >
                {tier.label}
              </button>
            ))}
          </div>
          <div
            id={`minion-tier-panel-${activeTier}`}
            role="tabpanel"
            aria-labelledby={`minion-tier-tab-${activeTier}`}
            className="settings-tier-panel"
          >
            <p><strong>{detail.label}</strong> {detail.description}</p>
            <ModelSelectionMenu
              model={selection.model}
              activeHarnessName={activeHarnessName}
              activeHarness={activeHarness}
              harnesses={harnesses}
              modelOptions={modelOptions}
              modelLabels={modelLabels}
              capability={getModelCapability(selection.model, activeHarness)}
              thinkingConfig={thinkingConfig}
              onModelChange={(model) => onTierModelChange(activeTier, model)}
              onHarnessChange={onHarnessChange}
              onThinkingConfigChange={activeTier === "standard" ? onThinkingConfigChange : undefined}
              hasSession={false}
              expanded
              triggerLabel={`${detail.label} Minion model${activeTier === "standard" ? " and reasoning" : ""}`}
              showThinkingToggle={activeTier === "standard"}
            />
          </div>
        </div>
      ) : (
        <div className="settings-tier-panel settings-tier-panel--fixed">
          <p>One model is used for every assignment unless the task specifies an exact override.</p>
          <ModelSelectionMenu
            model={selection.model}
            activeHarnessName={activeHarnessName}
            activeHarness={activeHarness}
            harnesses={harnesses}
            modelOptions={modelOptions}
            modelLabels={modelLabels}
            capability={getModelCapability(selection.model, activeHarness)}
            thinkingConfig={thinkingConfig}
            onModelChange={(model) => onTierModelChange("standard", model)}
            onHarnessChange={onHarnessChange}
            onThinkingConfigChange={onThinkingConfigChange}
            hasSession={false}
            expanded
            triggerLabel="Fixed Minion model and reasoning"
            showThinkingToggle
          />
        </div>
      )}
    </div>
  );
}
