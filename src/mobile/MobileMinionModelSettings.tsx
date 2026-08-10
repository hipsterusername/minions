import { useState } from "react";

import type { ProjectSettings } from "../api.ts";
import type { HarnessInfo } from "../harness-list.ts";
import { findHarness } from "../harness-list.ts";
import { getModelCapability } from "../model-meta.ts";
import {
  type ModelGroup,
  ModelSelect,
  normalizeThinkingConfig,
  normalizeThinkingForCapability,
  resolveModelSelection,
  ThinkingControls,
} from "../SettingsMenu.tsx";
import { MINION_THINKING_CONFIG } from "../types.ts";

type MinionTier = "mechanical" | "standard" | "reasoning";

const TIERS: ReadonlyArray<{ id: MinionTier; label: string; description: string }> = [
  { id: "mechanical", label: "Mechanical", description: "Fast, low-ambiguity work." },
  { id: "standard", label: "Standard", description: "General delegated work." },
  { id: "reasoning", label: "Reasoning", description: "Tricky or ambiguous work." },
];

interface MobileMinionModelSettingsProps {
  settings: ProjectSettings;
  harnesses: ReadonlyArray<HarnessInfo>;
  modelGroups: ModelGroup[];
  saveSettings: (settings: ProjectSettings) => void;
}

export function MobileMinionModelSettings({
  settings,
  harnesses,
  modelGroups,
  saveSettings,
}: MobileMinionModelSettingsProps) {
  const [activeTier, setActiveTier] = useState<MinionTier>("standard");
  const adaptive = settings.adaptiveMinionModelRouting === true;
  const minionSelection = resolveModelSelection(
    settings.defaultMinionHarness ?? "claude",
    settings.defaultMinionModel ?? settings.defaultModel ?? "claude-sonnet-5",
    modelGroups,
  );
  const activeGroups = modelGroups.filter((group) => group.harness === minionSelection.harness);
  const tierGroups = activeGroups.length > 0 ? activeGroups : modelGroups;
  const selections = {
    mechanical: resolveModelSelection(
      minionSelection.harness,
      settings.mechanicalMinionModel ?? minionSelection.model,
      tierGroups,
    ),
    standard: minionSelection,
    reasoning: resolveModelSelection(
      minionSelection.harness,
      settings.reasoningMinionModel ?? minionSelection.model,
      tierGroups,
    ),
  };
  const minionHarness = findHarness(harnesses, minionSelection.harness);
  const minionThinking = normalizeThinkingConfig(
    settings.defaultMinionThinkingConfig,
    MINION_THINKING_CONFIG,
  );
  const visibleTier = adaptive ? activeTier : "standard";
  const visibleSelection = selections[visibleTier];
  const visibleDetail = TIERS.find((tier) => tier.id === visibleTier)!;

  const saveSelection = (tier: MinionTier, selection: { harness: string; model: string }) => {
    const harnessChanged = selection.harness !== minionSelection.harness;
    const next: ProjectSettings = {
      ...settings,
      defaultMinionHarness: selection.harness,
    };
    if (harnessChanged) {
      next.defaultMinionModel = selection.model;
      next.mechanicalMinionModel = selection.model;
      next.reasoningMinionModel = selection.model;
    }
    if (tier === "standard") next.defaultMinionModel = selection.model;
    if (tier === "mechanical") next.mechanicalMinionModel = selection.model;
    if (tier === "reasoning") next.reasoningMinionModel = selection.model;
    if (tier === "standard" || harnessChanged) {
      next.defaultMinionThinkingConfig = normalizeThinkingForCapability(
        minionThinking,
        getModelCapability(selection.model, findHarness(harnesses, selection.harness)),
      );
    }
    saveSettings(next);
  };

  const toggleAdaptive = (checked: boolean) => {
    saveSettings({
      ...settings,
      adaptiveMinionModelRouting: checked,
      ...(checked
        ? {
            defaultMinionModel: selections.standard.model,
            mechanicalMinionModel: selections.mechanical.model,
            reasoningMinionModel: selections.reasoning.model,
          }
        : {}),
    });
  };

  return (
    <section className="mob-settings-section" aria-labelledby="mob-default-minion-heading">
      <div className="mob-settings-section-heading">
        <h2 id="mob-default-minion-heading">Default Minion</h2>
        <p>Use one fixed definition, or opt into capability-based assignment.</p>
      </div>

      <label className="mob-settings-toggle">
        <span>
          <strong>Adaptive tier routing</strong>
          <small>{adaptive ? "Choose a model for each assignment tier." : "Every tier uses the fixed model."}</small>
        </span>
        <input
          type="checkbox"
          checked={adaptive}
          onChange={(event) => toggleAdaptive(event.target.checked)}
        />
      </label>

      {adaptive ? (
        <div className="mob-tier-routing">
          <div className="mob-tier-tabs" role="tablist" aria-label="Minion assignment tiers">
            {TIERS.map((tier) => (
              <button
                key={tier.id}
                id={`mob-minion-tier-tab-${tier.id}`}
                type="button"
                role="tab"
                aria-selected={activeTier === tier.id}
                aria-controls={`mob-minion-tier-panel-${tier.id}`}
                data-active={activeTier === tier.id}
                onClick={() => setActiveTier(tier.id)}
              >
                {tier.label}
              </button>
            ))}
          </div>
          <div
            id={`mob-minion-tier-panel-${activeTier}`}
            role="tabpanel"
            aria-labelledby={`mob-minion-tier-tab-${activeTier}`}
            className="mob-tier-panel"
          >
            <p><strong>{visibleDetail.label}</strong> {visibleDetail.description}</p>
            <label className="mob-launch-field">
              <span>Model</span>
              <ModelSelect
                value={visibleSelection.value}
                groups={modelGroups}
                onChange={(selection) => saveSelection(activeTier, selection)}
              />
            </label>
            {activeTier === "standard" ? (
              <div className="mob-settings-control">
                <span>Reasoning</span>
                <ThinkingControls
                  config={minionThinking}
                  capability={getModelCapability(visibleSelection.model, minionHarness)}
                  onChange={(config) =>
                    saveSettings({
                      ...settings,
                      defaultMinionThinkingConfig: normalizeThinkingForCapability(
                        config,
                        getModelCapability(visibleSelection.model, minionHarness),
                      ),
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mob-tier-panel mob-tier-panel--fixed">
          <p>One model is used unless a task specifies an exact override.</p>
          <label className="mob-launch-field">
            <span>Model</span>
            <ModelSelect
              value={minionSelection.value}
              groups={modelGroups}
              onChange={(selection) => saveSelection("standard", selection)}
            />
          </label>
          <div className="mob-settings-control">
            <span>Reasoning</span>
            <ThinkingControls
              config={minionThinking}
              capability={getModelCapability(minionSelection.model, minionHarness)}
              onChange={(config) =>
                saveSettings({
                  ...settings,
                  defaultMinionThinkingConfig: normalizeThinkingForCapability(
                    config,
                    getModelCapability(minionSelection.model, minionHarness),
                  ),
                })
              }
            />
          </div>
        </div>
      )}
    </section>
  );
}
