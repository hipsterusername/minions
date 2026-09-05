import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormSubmissionProvider } from "./FormSubmissionProvider.tsx";
import { FormComponent } from "./FormComponent.tsx";
import type { FormComponent as Form } from "../../../shared/render-form.ts";

let sessionCounter = 0;
const question: Form = { id: "decision", type: "form", fields: [{ id: "answer", kind: "text", label: "Answer", default: "My draft" }] };
function setup() {
  const sessionKey = `session-${++sessionCounter}`;
  let listener: (msg: unknown) => void = () => {};
  const subscribe = (fn: (msg: unknown) => void) => { listener = fn; return () => {}; };
  const send = vi.fn();
  const fallback = vi.fn();
  const view = (connected = true, component = question) => (
    <FormSubmissionProvider sessionKey={sessionKey} socketSend={send} socketSubscribe={subscribe} connected={connected}>
      <FormComponent component={component} onSubmit={fallback} />
    </FormSubmissionProvider>
  );
  const result = render(view());
  const emit = (msg: object) => act(() => listener({ sessionKey, ...msg }));
  const submit = () => fireEvent.submit(result.container.querySelector("form")!);
  const reject = (extra = {}) => emit({ type: "control_response", command: "submit_form", requestId: send.mock.calls[0]![0].requestId, success: false, error: "Capacity reached", ...extra });
  return { ...result, sessionKey, send, emit, submit, reject, view, fallback };
}
afterEach(() => vi.useRealTimers());

describe("decision receipt lifecycle", () => {
  it("waits for authoritative answers and blocks repeated submit events", () => {
    const t = setup();
    t.submit(); t.submit();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.fallback).not.toHaveBeenCalled();
    expect(screen.getByText("Sending response…")).toBeInTheDocument();
    expect(screen.queryByText(/Response received/)).toBeNull();
    t.rerender(t.view(true, { ...question, submittedAnswers: { answer: "Server answer" } }));
    expect(screen.getByText("Response received ✓")).toBeInTheDocument();
    expect(screen.getByLabelText("Answer")).toHaveValue("Server answer");
  });

  it("ignores unrelated rejection and unlocks matching rejection with the exact draft", () => {
    const t = setup(); t.submit();
    t.reject({ requestId: "unrelated" });
    t.reject({ sessionKey: "other" });
    expect(screen.getByLabelText("Answer")).toBeDisabled();
    t.reject();
    expect(screen.getByRole("alert")).toHaveTextContent("Capacity reached");
    expect(screen.getByLabelText("Answer")).toBeEnabled();
    expect(screen.getByLabelText("Answer")).toHaveValue("My draft");
    t.submit();
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.send.mock.calls[1]![0].requestId).not.toBe(t.send.mock.calls[0]![0].requestId);
  });

  it("times out, reconciles on reconnect, and never resends an ambiguous response", () => {
    vi.useFakeTimers();
    const t = setup(); t.submit();
    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    expect(t.send).toHaveBeenLastCalledWith({ type: "sync_session", sessionKey: t.sessionKey });
    t.rerender(t.view(false)); t.rerender(t.view(true));
    t.emit({ type: "sync_response", found: true, renderState: { layout: {}, components: [question] } });
    t.submit();
    expect(t.send.mock.calls.filter(([msg]) => msg.type === "submit_form")).toHaveLength(1);
    expect(screen.getByLabelText("Answer")).toHaveValue("My draft");
    t.emit({ type: "sync_response", found: true, renderState: { layout: {}, components: [{ ...question, submittedAnswers: { answer: "Accepted" } }] } });
    expect(screen.getByText("Response received ✓")).toBeInTheDocument();
    expect(screen.getByLabelText("Answer")).toHaveValue("Accepted");
  });

  it("reconciles an already answered form without enabling a duplicate attempt", () => {
    const t = setup(); t.submit(); t.reject({ code: "FORM_ALREADY_SUBMITTED" });
    expect(screen.getByLabelText("Answer")).toBeDisabled();
    expect(screen.queryByText(/Response received/)).toBeNull();
    t.emit({ type: "sync_response", found: true, renderState: { layout: {}, components: [{ ...question, submittedAnswers: { answer: "Other client" } }] } });
    expect(screen.getByLabelText("Answer")).toHaveValue("Other client");
    t.submit();
    expect(t.send.mock.calls.filter(([msg]) => msg.type === "submit_form")).toHaveLength(1);
  });

  it("reconciles the global reconnect signal without a connection prop update", () => {
    const t = setup(); t.submit();
    t.emit({ type: "socket_reconnected", sessionKey: undefined });
    expect(t.send).toHaveBeenLastCalledWith({ type: "sync_session", sessionKey: t.sessionKey });
    expect(screen.getByText(/Not confirmed/)).toBeInTheDocument();
    t.submit();
    expect(t.send.mock.calls.filter(([msg]) => msg.type === "submit_form")).toHaveLength(1);
  });
});

 describe("decision persistence", () => {
  it("retains edited pending intent across entire provider remount and rejection", () => {
    const t = setup();
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Edited exact draft  " } });
    t.submit();
    t.unmount();
    const again = render(t.view());
    expect(screen.getByLabelText("Answer")).toHaveValue("Edited exact draft  ");
    fireEvent.submit(again.container.querySelector("form")!);
    expect(t.send.mock.calls.filter(([m]) => m.type === "submit_form")).toHaveLength(1);
    t.reject();
    expect(screen.getByLabelText("Answer")).toBeEnabled();
    again.unmount();
    render(t.view());
    expect(screen.getByLabelText("Answer")).toHaveValue("Edited exact draft  ");
    expect(screen.getByRole("alert")).toHaveTextContent("Capacity reached");
  });
  it("shares the draft and synchronous pending lock across providers", () => {
    const t = setup();
    const second = render(t.view());
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "Shared edit" } });
    expect(screen.getAllByRole("textbox")[1]).toHaveValue("Shared edit");
    act(() => { t.submit(); fireEvent.submit(second.container.querySelector("form")!); });
    expect(t.send.mock.calls.filter(([m]) => m.type === "submit_form")).toHaveLength(1);
  });
});

describe("decision recovery across absent surfaces", () => {
  it("receives a rejection while the provider is unmounted and preserves the edited draft", () => {
    const t = setup();
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Unsaved edit" } });
    t.submit(); t.unmount(); t.reject();
    render(t.view());
    expect(screen.getByLabelText("Answer")).toHaveValue("Unsaved edit");
    expect(screen.getByLabelText("Answer")).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Capacity reached");
  });

  it("preserves authoritative received answers through remount and ignores late rejection", () => {
    const t = setup(); t.submit(); t.unmount();
    t.emit({ type: "sync_response", found: true, renderState: { components: [{ ...question, submittedAnswers: { answer: "Authoritative" } }] } });
    t.reject();
    render(t.view());
    expect(screen.getByLabelText("Answer")).toHaveValue("Authoritative");
    expect(screen.getByText("Response received ✓")).toBeInTheDocument();
  });

  it("isolates session B while retaining session A's pending edit on the same mounted tree", () => {
    const t = setup();
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Session A edit" } });
    t.submit();
    t.rerender(<FormSubmissionProvider sessionKey={`${t.sessionKey}-b`} socketSend={t.send} socketSubscribe={undefined}>
      <FormComponent component={question} onSubmit={t.fallback} />
    </FormSubmissionProvider>);
    expect(screen.getByLabelText("Answer")).toHaveValue("My draft");
    expect(screen.getByLabelText("Answer")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Session B edit" } });
    t.rerender(t.view());
    expect(screen.getByLabelText("Answer")).toHaveValue("Session A edit");
    expect(screen.getByLabelText("Answer")).toBeDisabled();
    t.submit();
    expect(t.send.mock.calls.filter(([m]) => m.type === "submit_form")).toHaveLength(1);
  });

  it("keeps a stale receipt locked through remount until authoritative recovery", () => {
    const t = setup(); t.submit(); t.reject({ code: "FORM_ALREADY_SUBMITTED" }); t.unmount();
    render(t.view());
    expect(screen.getByLabelText("Answer")).toBeDisabled();
    t.emit({ type: "sync_response", found: true, renderState: { components: [question] } });
    expect(screen.getByLabelText("Answer")).toBeDisabled();
    t.emit({ type: "render_update", leaderSessionKey: t.sessionKey, action: "patch", updates: [{ id: question.id, submittedAnswers: { answer: "Recovered" } }] });
    expect(screen.getByLabelText("Answer")).toHaveValue("Recovered");
  });

  it("releases removed questions while absent, so a reused ID starts a new decision", () => {
    const t = setup(); t.submit(); t.unmount();
    t.emit({ type: "sync_response", found: true, renderState: { components: [] } });
    const newQuestion = { ...question };
    render(t.view(true, newQuestion));
    expect(screen.getByLabelText("Answer")).toBeEnabled();
    expect(screen.getByLabelText("Answer")).toHaveValue("My draft");
    fireEvent.submit(document.querySelector("form")!);
    expect(t.send.mock.calls.filter(([m]) => m.type === "submit_form")).toHaveLength(2);
    t.reject(); // old request cannot unlock the reused ID
    expect(screen.getByLabelText("Answer")).toBeDisabled();
  });

  it("retires a nested question when its containing section is removed", () => {
    const t = setup();
    t.emit({ type: "sync_response", found: true, renderState: { components: [{ id: "section", type: "section", title: "Questions", components: [question] }] } });
    t.submit(); t.unmount();
    t.emit({ type: "render_update", leaderSessionKey: t.sessionKey, action: "remove", ids: ["section"] });
    render(t.view(true, { ...question }));
    expect(screen.getByLabelText("Answer")).toBeEnabled();
  });
});
