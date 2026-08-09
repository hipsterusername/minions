import { useMemo, type KeyboardEvent, type RefObject } from "react";
import {
  Bot,
  Brain,
  FolderGit2,
  GitBranch,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { DEFAULT_THINKING_CONFIG, type ThinkingConfig } from "../../types.ts";
import { findHarness } from "../../harness-list.ts";
import { getModelCapability } from "../../model-meta.ts";
import { buildLaunchModelGroups, parseLaunchModelValue } from "../../mobile/launch-models.ts";
import { getPickableSkills, getSkill } from "../../skills/registry.ts";
import type { SkillTemplate } from "../../skills/types.ts";
import { useHarnessList } from "../../use-harness-list.tsx";
import type { PermissionMode } from "../../components/SessionToolbar.tsx";
import { LeaderPromptBar } from "./prompt/LeaderPromptBar.tsx";
import type { SlashCommand } from "./prompt/slash-commands.ts";
import type { LeaderData } from "./types.ts";
import { SandboxPolicyControls } from "./SandboxPolicyControls.tsx";

const PERMISSIONS: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: "auto", label: "Auto", description: "Approve safe operations" },
  { value: "default", label: "Ask", description: "Confirm risky operations" },
  { value: "acceptEdits", label: "Auto-edit", description: "Approve file edits" },
  { value: "plan", label: "Plan", description: "Require plan approval" },
  { value: "bypassPermissions", label: "Bypass", description: "Skip permission checks" },
];

const PROMPT_STARTERS = [
  {
    label: "Review",
    value: "Review the recent changes, identify risks, and recommend the next safest action.",
  },
  {
    label: "Fix",
    value: "Investigate the issue, isolate the root cause, and make the smallest reliable fix.",
  },
  {
    label: "Build",
    value: "Implement the requested feature end to end, including focused verification.",
  },
] as const;

function SkillVariables({
  skill,
  values,
  onChange,
}: {
  skill: SkillTemplate;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  if (skill.variables.length === 0) return null;
  return (
    <div className="leader-launch-skill-vars">
      {skill.variables.map((variable) => {
        const value = values[variable.name] ?? variable.defaultValue ?? "";
        const id = `leader-launch-skill-${skill.id}-${variable.name}`;
        return (
          <label key={variable.name} htmlFor={id}>
            <span>{variable.label}{variable.required ? <em> *</em> : null}</span>
            {variable.type === "select" ? (
              <select id={id} value={value} onChange={(event) => onChange(variable.name, event.target.value)}>
                {(variable.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : variable.type === "textarea" ? (
              <textarea
                id={id}
                rows={2}
                value={value}
                placeholder={variable.placeholder}
                onChange={(event) => onChange(variable.name, event.target.value)}
              />
            ) : (
              <input
                id={id}
                value={value}
                placeholder={variable.placeholder}
                onChange={(event) => onChange(variable.name, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function ActivityLaunchForm({
  nodeId,
  data,
  input,
  slashCommands,
  promptPlaceholder,
  submitDisabled,
  submitActive,
  textareaRef,
  projectPath,
  onInputChange,
  onKeyDown,
  onSubmit,
  onUpdate,
}: {
  nodeId: string;
  data: LeaderData;
  input: string;
  slashCommands: SlashCommand[];
  promptPlaceholder: string;
  submitDisabled: boolean;
  submitActive: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  projectPath?: string;
  onInputChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onSubmit: () => void;
  onUpdate: (patch: Partial<LeaderData>) => void;
}) {
  const { harnesses } = useHarnessList();
  const modelGroups = useMemo(() => buildLaunchModelGroups(harnesses), [harnesses]);
  const activeHarnessName = data.harness ?? "claude";
  const activeModel = data.model ?? "opus";
  const activeHarness = findHarness(harnesses, activeHarnessName);
  const modelValue = `${activeHarnessName}::${activeModel}`;
  const capability = getModelCapability(activeModel, activeHarness);
  const availableSkills = getPickableSkills();
  const selectedSkills = (data.skillIds ?? [])
    .map((id) => getSkill(id))
    .filter((skill): skill is SkillTemplate => skill !== undefined);
  const permissionOptions = PERMISSIONS.filter((permission) => {
    if (activeHarness && !activeHarness.capabilities.permissionPrompts) return false;
    return !(activeHarnessName === "codex" && permission.value === "plan");
  });
  const selectedPermission = permissionOptions.find(
    (permission) => permission.value === (data.permissionMode ?? "auto"),
  );
  const selectedModel = modelGroups
    .flatMap((group) => group.options)
    .find((option) => option.value === modelValue);
  const reasoningEffort = (data.thinkingConfig ?? DEFAULT_THINKING_CONFIG).effort;

  function updateSkill(id: string, checked: boolean) {
    const skillIds = checked
      ? [...new Set([...(data.skillIds ?? []), id])]
      : (data.skillIds ?? []).filter((skillId) => skillId !== id);
    const skillValues = { ...(data.skillValues ?? {}) };
    if (!checked) delete skillValues[id];
    onUpdate({ skillIds, skillValues });
  }

  function updateSkillValue(skillId: string, name: string, value: string) {
    onUpdate({
      skillValues: {
        ...(data.skillValues ?? {}),
        [skillId]: { ...(data.skillValues?.[skillId] ?? {}), [name]: value },
      },
    });
  }

  return (
    <div className="leader-launch-form">
      <div className="leader-launch-layout">
        <section className="leader-launch-primary" aria-label="Define the work">
          <div className="leader-launch-work">
            <div className="leader-launch-section-head">
              <div>
                <h3>Define the work</h3>
                <p>Describe the outcome. You can steer the leader from Activity after launch.</p>
              </div>
              <span className="leader-launch-ready">Ready to launch</span>
            </div>

            <label className="leader-launch-field" htmlFor={`leader-launch-title-${nodeId}`}>
              <span>Name <small>Optional</small></span>
              <input
                id={`leader-launch-title-${nodeId}`}
                value={data.taskName ?? ""}
                placeholder="e.g. Repair the release workflow"
                onChange={(event) => onUpdate({ taskName: event.target.value || null })}
              />
            </label>

            <div className="leader-launch-prompt-meta">
              <div className="leader-launch-prompt-label">
                <span>Goal</span>
                <small>Type / for commands</small>
              </div>
              <div className="leader-launch-starters" aria-label="Prompt starters">
                {PROMPT_STARTERS.map((starter) => (
                  <button key={starter.label} type="button" onClick={() => onInputChange(starter.value)}>
                    {starter.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="leader-launch-prompt">
              <LeaderPromptBar
                input={input}
                slashCommands={slashCommands}
                onInputChange={onInputChange}
                onKeyDown={onKeyDown}
                onSubmit={onSubmit}
                placeholder={promptPlaceholder}
                submitLabel="Launch leader"
                disabled={submitDisabled}
                active={submitActive}
                variant="overlay"
                portalSlashMenu
                autoFocus
                textareaRef={textareaRef}
              />
            </div>

            {data.error ? <div className="leader-launch-error" role="alert">{data.error}</div> : null}
          </div>

          <aside className="leader-launch-config" aria-label="Run setup">
            <div className="leader-launch-settings-head">
              <span className="leader-launch-settings-title">
                <span className="leader-launch-settings-icon" aria-hidden>
                  <Settings2 size={15} strokeWidth={2} />
                </span>
                <span>
                  <strong>Run configuration</strong>
                  <small>Adjust each setting in place</small>
                </span>
              </span>
              {projectPath ? (
                <div className="leader-launch-project">
                  <FolderGit2 size={14} aria-hidden />
                  <span>
                    <strong title={projectPath}>
                      {projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath}
                    </strong>
                    <small title={projectPath}>{projectPath}</small>
                  </span>
                </div>
              ) : null}
            </div>

            <div className="leader-launch-summary" aria-label="Configured settings">
              <span title={`Model: ${selectedModel?.label ?? activeModel}`}>
                <Bot size={12} aria-hidden />
                {selectedModel?.label ?? activeModel}
              </span>
              {selectedPermission ? (
                <span title={`Permissions: ${selectedPermission.label}`}>
                  <ShieldCheck size={12} aria-hidden />
                  {selectedPermission.label}
                </span>
              ) : null}
              {capability.supportsAdaptiveThinking ? (
                <span title={`Reasoning: ${reasoningEffort}`}>
                  <Brain size={12} aria-hidden />
                  {reasoningEffort === "xhigh" ? "Extra high" : reasoningEffort}
                </span>
              ) : null}
              <span title={data.worktreeIsolation ? "Isolated worktree" : "Shared project checkout"}>
                <GitBranch size={12} aria-hidden />
                {data.worktreeIsolation ? "Isolated" : "Shared"}
              </span>
              <span title="Agent process filesystem boundary">
                <ShieldCheck size={12} aria-hidden />
                {data.sandboxPolicy?.filesystemScope ?? "workspace-write"}
              </span>
              <span title={`${selectedSkills.length} selected skills`}>
                <Sparkles size={12} aria-hidden />
                {selectedSkills.length} {selectedSkills.length === 1 ? "skill" : "skills"}
              </span>
            </div>

            <div className="leader-launch-config-grid">
              <label className="leader-launch-field">
                <span>Model</span>
                <select
                  aria-label="Model"
                  value={modelValue}
                  onChange={(event) => {
                    const selection = parseLaunchModelValue(event.target.value);
                    if (selection) onUpdate({ harness: selection.harness, model: selection.model });
                  }}
                >
                  {!selectedModel ? <option value={modelValue}>{activeModel}</option> : null}
                  {modelGroups.map((group) => (
                    <optgroup key={group.harness} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              {permissionOptions.length > 0 ? (
                <label className="leader-launch-field">
                  <span>Permissions</span>
                  <select
                    aria-label="Permissions"
                    value={data.permissionMode ?? "auto"}
                    onChange={(event) => onUpdate({ permissionMode: event.target.value as PermissionMode })}
                  >
                    {permissionOptions.map((permission) => (
                      <option key={permission.value} value={permission.value}>
                        {permission.label} — {permission.description}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {capability.supportsAdaptiveThinking ? (
                <label className="leader-launch-field">
                  <span>Reasoning</span>
                  <select
                    aria-label="Reasoning effort"
                    value={reasoningEffort}
                    onChange={(event) => onUpdate({
                      thinkingConfig: {
                        ...(data.thinkingConfig ?? DEFAULT_THINKING_CONFIG),
                        enabled: true,
                        effort: event.target.value as ThinkingConfig["effort"],
                      },
                    })}
                  >
                    {capability.supportedEffortLevels.map((effort) => (
                      <option key={effort} value={effort}>{effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1)}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            <label className="leader-launch-toggle">
              <input
                type="checkbox"
                checked={data.worktreeIsolation ?? false}
                onChange={(event) => onUpdate({ worktreeIsolation: event.target.checked })}
              />
              <span>
                <strong>Isolated worktree</strong>
                <small>Keep this task's edits separate until review.</small>
              </span>
            </label>

            <SandboxPolicyControls
              policy={data.sandboxPolicy}
              effective={data.effectiveSandboxPolicy}
              onChange={(sandboxPolicy) => onUpdate({ sandboxPolicy })}
            />

            <section className="leader-launch-skills" aria-labelledby={`leader-launch-skills-${nodeId}`}>
              <div className="leader-launch-skills-head">
                <span>
                  <Sparkles size={14} aria-hidden />
                  <span>
                    <strong id={`leader-launch-skills-${nodeId}`}>Skills</strong>
                    <small>Arm this leader with focused instructions.</small>
                  </span>
                </span>
                <span className="leader-launch-skills-count">{selectedSkills.length} selected</span>
              </div>
              {availableSkills.length === 0 ? (
                <p className="leader-launch-empty-skills">No project skills available.</p>
              ) : (
                <div className="leader-launch-skill-list">
                  {availableSkills.map((skill) => {
                    const selected = (data.skillIds ?? []).includes(skill.id);
                    return (
                      <div className="leader-launch-skill" data-selected={selected} key={skill.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(event) => updateSkill(skill.id, event.target.checked)}
                          />
                          <span className="leader-launch-skill-icon" aria-hidden>{skill.icon}</span>
                          <span>
                            <strong>{skill.name}</strong>
                            <small>{skill.description}</small>
                          </span>
                        </label>
                        {selected ? (
                          <SkillVariables
                            skill={skill}
                            values={data.skillValues?.[skill.id] ?? {}}
                            onChange={(name, value) => updateSkillValue(skill.id, name, value)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </aside>
        </section>
      </div>
    </div>
  );
}
