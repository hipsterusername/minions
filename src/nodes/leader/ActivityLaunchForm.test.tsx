import { act, createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HarnessListProvider } from "../../use-harness-list.tsx";
import { ActivityLaunchForm } from "./ActivityLaunchForm.tsx";
import { LEADER_DEFAULT_DATA } from "./types.ts";

describe("ActivityLaunchForm permission authority", () => {
  it("uses only sandbox policy controls for a Codex launch", () => {
    let receive: ((message: unknown) => void) | undefined;
    render(
      <HarnessListProvider connected send={vi.fn()} subscribe={(listener) => {
        receive = listener;
        return () => undefined;
      }}>
        <ActivityLaunchForm
          nodeId="leader-1"
          data={{ ...LEADER_DEFAULT_DATA, harness: "codex", model: "gpt-5.6-sol" }}
          input=""
          slashCommands={[]}
          promptPlaceholder="Describe work"
          submitDisabled={false}
          submitActive={false}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onInputChange={vi.fn()}
          onKeyDown={vi.fn()}
          onSubmit={vi.fn()}
          onUpdate={vi.fn()}
        />
      </HarnessListProvider>,
    );
    act(() => receive?.({
      type: "harness_list",
      harnesses: [{
        name: "codex",
        capabilities: {
          mutationInterception: "observe_only", thinking: true, promptCaching: true,
          mcp: true, permissionPrompts: true, resume: true, partialMessages: false,
          builtInFilesystem: true,
          sandboxEnforcement: {
            filesystem: ["read-only", "workspace-write", "unrestricted"],
            approval: true,
          },
        },
        builtInTools: [],
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
        commands: [], agents: [], account: { provider: "openai" },
      }],
    }));

    expect(screen.queryByLabelText("Permissions")).toBeNull();
    expect(screen.getByLabelText("Sandbox approval policy")).toBeInTheDocument();
  });
});
