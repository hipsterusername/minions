import { findHarness, type HarnessInfo } from "../harness-list.ts";
import { getModelCapability } from "../model-meta.ts";
import { DEFAULT_THINKING_CONFIG, type EffortLevel, type ThinkingConfig } from "../types.ts";
import type { LaunchModelGroup } from "./launch-models.ts";
import { parseLaunchModelValue } from "./launch-models.ts";

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

interface MobileLeaderRuntimeControlsProps {
  harnesses: ReadonlyArray<HarnessInfo>;
  modelGroups: LaunchModelGroup[];
  modelValue: string;
  projectThinkingConfig?: ThinkingConfig | undefined;
  thinkingOverride: ThinkingConfig | null;
  onModelChange: (value: string) => void;
  onThinkingOverrideChange: (config: ThinkingConfig | null) => void;
}

export function MobileLeaderRuntimeControls({
  harnesses,
  modelGroups,
  modelValue,
  projectThinkingConfig,
  thinkingOverride,
  onModelChange,
  onThinkingOverrideChange,
}: MobileLeaderRuntimeControlsProps) {
  const selection = parseLaunchModelValue(modelValue);
  const harness = selection ? findHarness(harnesses, selection.harness) : null;
  const capability = selection ? getModelCapability(selection.model, harness) : null;
  const selectedGroup = selection
    ? modelGroups.find((group) => group.harness === selection.harness)
    : null;
  const selectedOption = selection
    ? selectedGroup?.options.find((option) => option.id === selection.model)
    : null;
  const inherited = projectThinkingConfig ?? DEFAULT_THINKING_CONFIG;
  const effectiveThinking = thinkingOverride ?? inherited;

  const chooseEffort = (effort: EffortLevel) => {
    onThinkingOverrideChange({ ...effectiveThinking, enabled: true, effort });
  };

  return (
    <section className="mob-leader-runtime" aria-labelledby="mob-leader-runtime-heading">
      <div className="mob-leader-runtime-heading">
        <div>
          <span>Run setup</span>
          <h2 id="mob-leader-runtime-heading">Model &amp; reasoning</h2>
        </div>
        <span className="mob-runtime-badge">
          {thinkingOverride === null
            ? "Project default"
            : thinkingOverride.enabled
              ? EFFORT_LABELS[thinkingOverride.effort]
              : "Off"}
        </span>
      </div>

      <label className="mob-launch-field">
        <span>Model</span>
        <select value={modelValue} onChange={(event) => onModelChange(event.currentTarget.value)}>
          <option value="">Project default</option>
          {modelGroups.map((group) => (
            <optgroup key={group.harness} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="mob-control-help">
        {selection
          ? `${selectedOption?.label ?? selection.model} · ${selectedGroup?.label ?? selection.harness}`
          : "Uses the model saved for this project."}
      </p>

      <fieldset className="mob-reasoning-control">
        <legend>Reasoning</legend>
        {!selection ? (
          <p className="mob-control-help">
            Reasoning follows the project default. Choose a model to override it for this run.
          </p>
        ) : capability?.supportsAdaptiveThinking ? (
          <>
            <div className="mob-reasoning-options" aria-label="Reasoning effort">
              <button
                type="button"
                data-active={thinkingOverride === null}
                aria-pressed={thinkingOverride === null}
                onClick={() => onThinkingOverrideChange(null)}
              >
                Default
              </button>
              <button
                type="button"
                data-active={thinkingOverride?.enabled === false}
                aria-pressed={thinkingOverride?.enabled === false}
                onClick={() => onThinkingOverrideChange({ ...effectiveThinking, enabled: false })}
              >
                Off
              </button>
              {capability.supportedEffortLevels.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  data-active={thinkingOverride?.enabled === true && thinkingOverride.effort === effort}
                  aria-pressed={thinkingOverride?.enabled === true && thinkingOverride.effort === effort}
                  onClick={() => chooseEffort(effort)}
                >
                  {EFFORT_LABELS[effort]}
                </button>
              ))}
            </div>

            <div className="mob-reasoning-output">
              <span>Reasoning output</span>
              <div aria-label="Reasoning output visibility">
                <button
                  type="button"
                  disabled={!effectiveThinking.enabled}
                  data-active={effectiveThinking.display === "summarized"}
                  aria-pressed={effectiveThinking.display === "summarized"}
                  onClick={() =>
                    onThinkingOverrideChange({ ...effectiveThinking, display: "summarized" })
                  }
                >
                  Summaries
                </button>
                <button
                  type="button"
                  disabled={!effectiveThinking.enabled}
                  data-active={effectiveThinking.display === "omitted"}
                  aria-pressed={effectiveThinking.display === "omitted"}
                  onClick={() =>
                    onThinkingOverrideChange({ ...effectiveThinking, display: "omitted" })
                  }
                >
                  Hidden
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="mob-reasoning-unavailable" role="status">
            This model does not expose reasoning controls. Reasoning will be disabled for this run.
          </p>
        )}
      </fieldset>
    </section>
  );
}
