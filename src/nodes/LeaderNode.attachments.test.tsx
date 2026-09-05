import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderNodeRenderer, resetLeaderAutoStartClaimsForTests } from "./LeaderNode.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./leader/types.ts";
import { loadImageFromFile } from "./image-loader.ts";
import { createReplaySocket } from "../../tests/harness/ws-replay.ts";
import type { WorkItemSnapshot } from "../../shared/work-item-contracts.ts";

vi.mock("../use-harness-list.tsx", () => ({ useHarnessList: () => ({ loaded: true,
  harnesses: [{ name: "claude", models: [{ id: "opus", label: "Opus" }],
    capabilities: { thinking: true, permissionPrompts: true, resume: true },
    builtInTools: [], commands: [], agents: [], account: { provider: "anthropic" } }],
}) }));
vi.mock("./image-loader.ts", () => ({ loadImageFromFile: vi.fn() }));
const image = { src: "data:image/png;base64,cGl4ZWxz", mediaType: "image/png", filename: "shot.png",
  naturalWidth: 100, naturalHeight: 100 };
const attachment = { kind: "image", mediaType: "image/png", filename: "shot.png", data: "cGl4ZWxz" };
const item: WorkItemSnapshot = {
  id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
  lifecycle: { runtimeState: "inactive", outcome: "completed", resolution: "open",
    changeMode: "live", integrationState: "live_clean", lifecycleRevision: 3 },
  waitKind: null, currentRunKey: "run-1", iteration: 1, lastTransitionAt: 3, createdAt: 1, updatedAt: 3,
};
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
});
beforeEach(() => {
  resetLeaderAutoStartClaimsForTests();
  vi.mocked(loadImageFromFile).mockReset().mockResolvedValue(image);
});
function setup(initial: Partial<LeaderData> = {}, launchMode = false, canonical = false) {
  const { socket, replay } = createReplaySocket();
  function Probe() {
    const [data, setData] = useState({ ...LEADER_DEFAULT_DATA, ...initial });
    return <LeaderNodeRenderer node={{ id: "attachment-leader", type: "leader",
      position: { x: 0, y: 0 }, size: { width: 560, height: 520 }, data }}
      isSelected={false} launchMode={launchMode}
      {...(canonical ? { projectId: "project-1", projectPath: "/repo" } : {})}
      socketSubscribe={socket.subscribe} socketSend={socket.send}
      onUpdateData={next => setData(next as LeaderData)} />;
  }
  render(<Probe />);
  const commands = (type: string) => socket.sent.filter(message =>
    (message as { type?: string }).type === type) as Record<string, unknown>[];
  return { commands, replay };
}
function paste(files = [new File(["pixels"], "shot.png", { type: "image/png" })]) {
  fireEvent.paste(screen.getByLabelText("Leader prompt"), { clipboardData: {
    files, items: [], getData: () => "",
  } });
}
async function readyImage() {
  await waitFor(() => expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument());
}

describe("Leader pasted context", () => {
  it("sends pasted images on a new leader and clears only the submitted draft after launch", async () => {
    const test = setup();
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const create = test.commands("create_session")[0]!;
    expect(create).toMatchObject({ attachments: [attachment] });
    expect(create['prompt']).toContain("Use the attached context.");
    expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
    paste([new File(["new"], "next.png", { type: "image/png" })]);
    await waitFor(() => expect(screen.getByRole("img", { name: "next.png" })).toBeInTheDocument());
    await act(() => test.replay([{ message: { type: "session_status",
      sessionKey: create['sessionKey'] as string, status: "running" } }]));
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(screen.getByRole("img", { name: "next.png" })).toBeInTheDocument();
  });

  it("attaches from the new-leader launch form through the canonical start command", async () => {
    const test = setup({}, true, true);
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));
    for (const type of ["create_work_item", "attach_work_item_surface"]) {
      await waitFor(() => expect(test.commands(type)).toHaveLength(1));
      const command = test.commands(type)[0]!;
      await act(() => test.replay([{ message: { type: "work_item_response", command: type,
        requestId: command['requestId'] as string, success: true,
        result: { workItem: { ...item, currentRunKey: null,
          lifecycle: { ...item.lifecycle, runtimeState: "draft", outcome: "none" } },
          bindings: [], currentRun: null, runs: [], nextCursor: null } } }]));
    }
    await waitFor(() => expect(test.commands("continue_work_item")).toHaveLength(1));
    expect(test.commands("continue_work_item")[0]).toMatchObject({ attachments: [attachment] });
  });

  it.each([false, true])("sends images with follow-ups (canonical iteration: %s) and keeps them on retry", async canonical => {
    const test = setup({ sessionKey: "run-1", status: canonical ? "completed" : "idle",
      ...(canonical ? { workItemId: item.id, workItemSnapshot: item } : {}) });
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: canonical ? "New iteration" : "Send" }));
    const type = canonical ? "continue_work_item" : "send_message";
    await waitFor(() => expect(test.commands(type)).toHaveLength(1));
    const command = test.commands(type)[0]!;
    expect(command).toMatchObject({ attachments: [attachment] });
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    await act(() => test.replay([{ message: canonical
      ? { type: "work_item_response", command: type, requestId: command['requestId'] as string,
        success: false, code: "invalid_state", error: "Try again" }
      : { type: "control_response", command: type, sessionKey: "run-1",
        requestId: command['requestId'] as string, success: false, error: "Try again" } }]));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(test.commands(type)).toHaveLength(2));
    expect(test.commands(type)[1]).toMatchObject({ attachments: [attachment] });
  });

  it("blocks submission during decoding and lets failed files be removed", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(loadImageFromFile).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const test = setup();
    paste();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("Leader prompt"), { key: "Enter" });
    expect(test.commands("create_session")).toHaveLength(0);
    await act(async () => reject(new Error("Image decode failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Image decode failed");
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("includes pasted text files as context and preserves ordinary text paste", async () => {
    const test = setup();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], items: [], getData: () => "words" } });
    fireEvent(screen.getByLabelText("Leader prompt"), event);
    expect(event.defaultPrevented).toBe(false);
    paste([new File(["The acceptance criteria"], "notes.md", { type: "text/markdown" })]);
    await waitFor(() => expect(screen.queryByText(/Loading…/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(test.commands("create_session")[0]?.['prompt']).toContain("The acceptance criteria");
    expect(test.commands("create_session")[0]?.['attachments']).toBeUndefined();
  });

  it("preserves the draft across fullscreen and removes attachments before sending", async () => {
    const test = setup();
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    fireEvent.change(screen.getByLabelText("Leader prompt"), { target: { value: "Just the prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(test.commands("create_session")[0]?.['attachments']).toBeUndefined();
  });

  it("retains images when a new leader fails to launch", async () => {
    const test = setup();
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const create = test.commands("create_session")[0]!;
    await act(() => test.replay([{ message: { type: "session_status",
      sessionKey: create['sessionKey'] as string, status: "error" } }]));
    expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(test.commands("create_session")[1]).toMatchObject({ attachments: [attachment] });
  });

  it("handles clipboard items when files are unavailable and leaves removed loads removed", async () => {
    let resolve!: (value: typeof image) => void;
    vi.mocked(loadImageFromFile).mockReturnValue(new Promise(done => { resolve = done; }));
    setup();
    fireEvent.paste(screen.getByLabelText("Leader prompt"), { clipboardData: {
      items: [{ kind: "file", getAsFile: () => new File(["pixels"], "shot.png", { type: "image/png" }) }],
      getData: () => "",
    } });
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    await act(async () => resolve(image));
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("carries pasted images into legacy new sessions", async () => {
    const test = setup({ sessionKey: "old-run", status: "completed" });
    paste();
    await readyImage();
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await waitFor(() => expect(test.commands("create_session")).toHaveLength(1));
    expect(test.commands("create_session")[0]).toMatchObject({ attachments: [attachment] });
  });
});
