import { act, createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HarnessListProvider } from "../../use-harness-list.tsx";
import { ActivityLaunchForm } from "./ActivityLaunchForm.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./types.ts";

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


describe("Activity launch readiness", () => {
  it("validates input and availability, locks pending launch, and preserves settings on failure", () => {
    let receive: ((message: unknown) => void) | undefined;
    const submit = vi.fn();
    function Probe() {
      const [input, setInput] = useState("");
      const [pending, setPending] = useState(false);
      const [data, setData] = useState<LeaderData>({ ...LEADER_DEFAULT_DATA, taskName: "My launch" });
      return <>
        <ActivityLaunchForm nodeId="launch-test" data={data} input={input}
          slashCommands={[]} promptPlaceholder="Goal" submitDisabled={false} submitActive
          textareaRef={createRef<HTMLTextAreaElement>()} pending={pending}
          onInputChange={setInput} onKeyDown={() => undefined}
          onSubmit={() => { submit(); setPending(true); }} onUpdate={(patch) => setData({ ...data, ...patch })} />
        <button onClick={() => { setPending(false); setData({ ...data, error: "Launch rejected" }); }}>Reject</button>
      </>;
    }
    render(<HarnessListProvider connected send={() => undefined} subscribe={(listener) => {
      receive = listener; return () => undefined;
    }}><Probe /></HarnessListProvider>);
    expect(screen.getByText("Describe a goal to launch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch leader" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Goal"), { target: { value: "My exact goal" } });
    expect(screen.getByText("Checking model availability…")).toBeInTheDocument();
    act(() => receive?.({ type: "harness_list", harnesses: [{
      name: "claude", capabilities: { permissionPrompts: true }, models: [{ id: "opus", label: "Opus" }],
      builtInTools: [], commands: [], agents: [], account: { provider: "anthropic" },
    }] }));
    expect(screen.getByText("Ready to launch")).toBeInTheDocument();
    const launch = screen.getByRole("button", { name: "Launch leader" });
    fireEvent.click(launch); fireEvent.click(launch);
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Starting leader…" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Goal")).toHaveValue("My exact goal");
    fireEvent.click(screen.getByText("Reject"));
    expect(screen.getByRole("alert")).toHaveTextContent("Launch rejected");
    expect(screen.getByPlaceholderText("Goal")).toHaveValue("My exact goal");
    expect(screen.getByLabelText(/Name/)).toHaveValue("My launch");
    expect(screen.getByLabelText("Model")).toHaveValue("claude::opus");
    expect(screen.getByRole("button", { name: "Launch leader" })).toBeEnabled();
  });
});
