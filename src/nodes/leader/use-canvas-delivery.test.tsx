import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./types.ts";
import { useCanvasWorkItem } from "./use-canvas-work-item.ts";
import { useCanvasDelivery } from "./use-canvas-delivery.ts";
import { CanvasDeliveryContext } from "./CanvasDeliveryReceipt.tsx";
import { UserMessageBubble } from "./messages/UserMessageBubble.tsx";
import type { FrozenLeaderPrompt } from "./frozen-prompt.ts";

const item: WorkItemSnapshot = {
  id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
  lifecycle: { runtimeState: "working", outcome: "none", resolution: "open",
    changeMode: "live", integrationState: "live_clean", lifecycleRevision: 2 },
  waitKind: null, currentRunKey: "run-1", iteration: 1,
  lastTransitionAt: 2, createdAt: 1, updatedAt: 2,
};
function setup(canonical = true, initial: Partial<LeaderData> = {}) {
  const listeners = new Set<(message: unknown) => void>();
  const socketSubscribe = (listener: (message: unknown) => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  };
  const socketSend = vi.fn();
  const receive = (message: unknown) => { for (const listener of listeners) listener(message); };
  let current: LeaderData;
  function Probe() {
    const [data, setData] = useState<LeaderData>({ ...LEADER_DEFAULT_DATA,
      sessionKey: "run-1", ...(canonical ? { workItemId: item.id, workItemSnapshot: item } : {}), ...initial });
    const [draft, setDraft] = useState("  Exact text\nwith spacing  ");
    const dataRef = useRef(data); dataRef.current = data; current = data;
    const frozenPromptRef = useRef<FrozenLeaderPrompt | null>(null);
    const emitUpdate = (next: LeaderData) => { dataRef.current = next; setData(next); };
    const workItem = useCanvasWorkItem({ nodeId: "node-1", projectId: "project-1",
      projectPath: "/repo", socketSend, socketSubscribe, dataRef, emitUpdate,
      publishCanvasContext: () => undefined });
    const delivery = useCanvasDelivery({ ...workItem, dataRef, emitUpdate, socketSend, socketSubscribe,
      frozenPromptRef, getContextForNode: undefined });
    return <CanvasDeliveryContext.Provider value={delivery}>
      <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { if (delivery.send(draft)) setDraft(""); }}>Send</button>
      {data.messages.map((message) => <UserMessageBubble key={message.id} msg={message} />)}
    </CanvasDeliveryContext.Provider>;
  }
  render(<Probe />);
  const commands = () => socketSend.mock.calls.map(([command]) => command as Record<string, unknown>)
    .filter((command) => command['type'] === (canonical ? "continue_work_item" : "send_message"));
  const reply = async (success: boolean, requestId = commands().at(-1)?.['requestId']) => {
    await act(async () => receive({ type: canonical ? "work_item_response" : "control_response",
      command: "send_message", sessionKey: "run-1", requestId, success,
      ...(success ? { result: { workItem: item, bindings: [] } }
        : { error: "Rejected by server", code: "invalid_state" }) }));
  };
  return { commands, reply, receive, socketSend, data: () => current! };
}

afterEach(() => vi.useRealTimers());
describe("Canvas message delivery", () => {
  it("queries the completed receipt after timeout and reconnect without resending the mutation", async () => {
    vi.useFakeTimers();
    const test = setup();
    fireEvent.click(screen.getByText("Send"));
    const requestId = test.commands()[0]?.['requestId'];
    expect(Object.values(test.data().messageDelivery ?? {})[0]).toMatchObject({
      requestId, workItemId: item.id,
    });
    await act(async () => { vi.advanceTimersByTime(15_001); });
    expect(test.socketSend).toHaveBeenCalledWith({ type: "get_work_item_receipt", requestId, workItemId: item.id });
    act(() => test.receive({ type: "work_item_receipt_pending", requestId }));
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    test.socketSend.mockClear();
    act(() => test.receive({ type: "socket_reconnected" }));
    expect(test.socketSend).toHaveBeenCalledWith({ type: "get_work_item_receipt", requestId, workItemId: item.id });
    expect(test.commands()).toHaveLength(0);
    await test.reply(true, requestId);
    expect(screen.getByText("Queued for leader")).toBeInTheDocument();
    test.socketSend.mockClear();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(test.socketSend.mock.calls.some(([command]) => command.requestId === requestId)).toBe(false);
  });

  it("restores canonical correlation after reload and recovers a completed receipt", async () => {
    const test = setup(true, {
      messages: [{ id: "old", role: "user", content: "Old text", timestamp: 1 }],
      messageDelivery: { old: { state: "unconfirmed", text: "Old text", requestId: "old-request", workItemId: item.id } },
    });
    expect(test.socketSend).toHaveBeenCalledWith({ type: "get_work_item_receipt", requestId: "old-request", workItemId: item.id });
    await test.reply(true, "unrelated");
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    await test.reply(true, "old-request");
    expect(screen.queryByText(/Not confirmed/)).toBeNull();
    expect(test.data().messageDelivery?.['old']?.state).toBe("accepted");
    expect(test.commands()).toHaveLength(0);
  });

  it("immediately recovers restored receipts on reconnect and survives a failed lookup send", async () => {
    vi.useFakeTimers();
    const test = setup(true, {
      messages: [{ id: "old", role: "user", content: "Old text", timestamp: 1 }],
      messageDelivery: { old: { state: "unconfirmed", text: "Old text", requestId: "old-request", workItemId: item.id } },
    });
    test.socketSend.mockClear();
    act(() => test.receive({ type: "socket_reconnected" }));
    expect(test.socketSend).toHaveBeenCalledWith({
      type: "get_work_item_receipt", requestId: "old-request", workItemId: item.id,
    });
    test.socketSend.mockImplementation((command) => {
      if (command.requestId === "old-request") throw new Error("Disconnected");
    });
    expect(() => act(() => test.receive({ type: "socket_reconnected" }))).not.toThrow();
    test.socketSend.mockReset();
    await test.reply(true, "old-request");
    expect(test.data().messageDelivery?.['old']?.state).toBe("accepted");
    test.socketSend.mockClear();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(test.socketSend.mock.calls.some(([command]) => command.requestId === "old-request")).toBe(false);
    expect(test.commands()).toHaveLength(0);
  });

  it("permits retry when a state refresh times out before any prompt was submitted", async () => {
    vi.useFakeTimers();
    const test = setup(true, { workItemSnapshot: null });
    fireEvent.click(screen.getByText("Send"));
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(test.commands()).toHaveLength(0);
    expect(screen.getByText(/Not sent/)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("keeps exact rejected text on its bubble, retries once, and preserves a newer draft", async () => {
    const test = setup();
    fireEvent.click(screen.getByText("Send"));
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "New draft" } });
    fireEvent.click(screen.getByText("Send"));
    expect(test.commands()).toHaveLength(1);
    await test.reply(true, "unrelated-request");
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    await test.reply(false);
    expect(screen.getByText(/Not sent/)).toBeInTheDocument();
    const retry = screen.getByText("Retry");
    fireEvent.click(retry); fireEvent.click(retry);
    expect(test.commands()).toHaveLength(2);
    expect(test.commands()[1]?.['prompt']).toBe(test.commands()[0]?.['prompt']);
    expect(test.data().messages).toHaveLength(1);
    expect(test.data().messages[0]?.content).toBe("  Exact text\nwith spacing  ");
    expect(screen.getByLabelText("Draft")).toHaveValue("New draft");
    await test.reply(true);
    expect(screen.getByText("Queued for leader")).toBeInTheDocument();
    expect(screen.getByLabelText("Draft")).toHaveValue("New draft");
  });

  it("does not resend uncertain transport work and accepts a late correlated receipt", async () => {
    vi.useFakeTimers();
    const test = setup();
    fireEvent.click(screen.getByText("Send"));
    await act(async () => { vi.advanceTimersByTime(15_001); });
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    expect(screen.queryByText("Retry")).toBeNull();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Exact text\nwith spacing" } });
    fireEvent.click(screen.getByText("Send"));
    expect(test.commands()).toHaveLength(1);
    await test.reply(true);
    expect(screen.getByText("Queued for leader")).toBeInTheDocument();
    expect(test.commands()).toHaveLength(1);
  });

  it.each([true, false])("allows distinct text after uncertainty and honors late receipts (canonical=%s)", async (canonical) => {
    vi.useFakeTimers();
    const test = setup(canonical);
    fireEvent.click(screen.getByText("Send"));
    const first = test.commands()[0]?.['requestId'];
    await act(async () => { vi.advanceTimersByTime(15_001); });
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "New question" } });
    fireEvent.click(screen.getByText("Send"));
    expect(test.commands()).toHaveLength(2);
    await test.reply(true, first);
    expect(screen.getByText(canonical ? "Queued for leader" : /Accepted by server/)).toBeInTheDocument();
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  it("matches legacy command, session and request; recovers definite failures with fresh correlation", async () => {
    const test = setup(false);
    fireEvent.click(screen.getByText("Send"));
    const requestId = test.commands()[0]?.['requestId'];
    expect(requestId).toEqual(expect.any(String));
    act(() => {
      test.receive({ type: "control_response", command: "submit_form", sessionKey: "run-1", requestId, success: true });
      test.receive({ type: "control_response", command: "send_message", sessionKey: "other", requestId, success: true });
    });
    await test.reply(true, "other");
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    await test.reply(false);
    fireEvent.click(screen.getByText("Retry"));
    expect(test.commands()).toHaveLength(2);
    expect(test.commands()[1]?.['requestId']).not.toBe(requestId);
    await test.reply(true, requestId);
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    await test.reply(true);
    expect(screen.getByText(/Accepted by server/)).toBeInTheDocument();
  });

  it.each([true, false])("reconnect marks pending sends uncertain without replay (canonical=%s)", async (canonical) => {
    const test = setup(canonical);
    fireEvent.click(screen.getByText("Send"));
    act(() => test.receive({ type: "socket_reconnected" }));
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Exact text\nwith spacing" } });
    fireEvent.click(screen.getByText("Send"));
    expect(test.commands()).toHaveLength(1);
    await test.reply(true);
    expect(screen.queryByText(/Not confirmed/)).toBeNull();
  });

  it("restores persisted sending as uncertain and accepts its late legacy receipt", async () => {
    const test = setup(false, {
      messages: [{ id: "old", role: "user", content: "Old text", timestamp: 1 }],
      messageDelivery: { old: { state: "sending", text: "Old text", requestId: "old-request", sessionKey: "run-1" } },
    });
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Old text" } });
    fireEvent.click(screen.getByText("Send"));
    expect(test.commands()).toHaveLength(0);
    await test.reply(true, "old-request");
    expect(screen.getByText(/Accepted by server/)).toBeInTheDocument();
  });
});
