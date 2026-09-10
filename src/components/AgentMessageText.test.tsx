import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentMessageText } from "./AgentMessageText.tsx";
import { ChatLinkScope } from "./ChatLink.tsx";

describe("AgentMessageText", () => {
  it.each(["passed", "failed", "inconclusive"])("renders a readable %s verdict", result => {
    const { container } = render(<AgentMessageText text={JSON.stringify({
      result, confidence: 0.98, summary: "Checks finished. **Host acceptance remains unavailable.**",
    })} />);
    expect(screen.getByText(`Verification: ${result[0]!.toUpperCase()}${result.slice(1)}`)).toBeInTheDocument();
    expect(screen.getByText("Confidence: 98%")).toBeInTheDocument();
    expect(screen.getByText("Host acceptance remains unavailable.").tagName).toBe("STRONG");
    expect(container.textContent).not.toContain('"result"');
  });

  it("discloses the complete evidence on demand even in a clipped message", () => {
    const summary = "Evidence checked. ".repeat(80) + "Leader reconciliation remains pending.";
    const text = JSON.stringify({ result: "inconclusive", confidence: 0.98, summary });
    const { container } = render(<AgentMessageText text={text} maxLength={700} />);
    expect(screen.getByText("Verification: Inconclusive")).not.toBeVisible();
    fireEvent.click(screen.getByText("View report details"));
    expect(screen.getByText("Verification: Inconclusive")).toBeVisible();
    expect(container.textContent).toContain(summary);
    fireEvent.click(screen.getByText("View report details"));
    expect(screen.getByText("Verification: Inconclusive")).not.toBeVisible();
  });

  it("opens report file links in the scoped viewer without selecting the message", () => {
    const onSelect = vi.fn();
    render(<div onClick={onSelect} onKeyDown={onSelect}>
      <ChatLinkScope project="workspace" cwd="/repo">
        <AgentMessageText text={JSON.stringify({ summary: "[Review evidence](.scratch/review.md:12)" })} />
      </ChatLinkScope>
    </div>);
    expect(screen.getByText("Review evidence")).not.toBeVisible();
    const toggle = screen.getByText("View report details");
    fireEvent.click(toggle);
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "Review evidence" });
    expect(link).toHaveAttribute("href", "/file-view?project=workspace&path=%2Frepo%2F.scratch%2Freview.md&line=12");
  });

  it("supports a verdict without an optional summary", () => {
    render(<AgentMessageText text={'{"result":"failed","confidence":0}'} />);
    expect(screen.getByText("Verification: Failed")).toBeInTheDocument();
    expect(screen.getByText("Confidence: 0%")).toBeInTheDocument();
  });

  it.each([
    '{"result":"inconclusive","confidence":0.98,"summary":"still streaming',
    'Example: {"result":"passed","confidence":1}',
  ])("keeps incomplete JSON and prose visible: %s", text => {
    const { container } = render(<AgentMessageText text={text} />);
    expect(screen.queryByLabelText("Verification result")).not.toBeInTheDocument();
    expect(container.textContent).toBe(text);
  });

  it.each([
    '{"result":"other","confidence":0.98}',
    '{"result":"passed","confidence":1.1}',
    '{"result":"passed","confidence":"0.98"}',
    '{"result":"passed","confidence":1,"summary":42}',
    '{"result":"passed","confidence":1,"summary":" "}',
  ])("renders invalid verdicts as general fields without a verification badge: %s", text => {
    render(<AgentMessageText text={text} />);
    expect(screen.queryByLabelText("Verification result")).not.toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("Confidence")).toBeInTheDocument();
  });

  it.each(["summary", "message", "text", "answer", "report", "result", "content"])("formats a %s envelope", key => {
    render(<AgentMessageText text={JSON.stringify({ [key]: "**Completed**\n\nNext steps remain." })} />);
    expect(screen.getByText("Completed").tagName).toBe("STRONG");
    expect(screen.getByText("Next steps remain.")).toBeInTheDocument();
  });

  it("retains extra verdict fields, nested findings, and falsy values", () => {
    render(<AgentMessageText text={JSON.stringify({ result: "failed", confidence: 0.8,
      summary: "Checks failed.", findings: [{ file_path: "src/a.ts", line: 0, resolved: false,
        reason: null, evidence: [], metadata: {}, note: "" }], nextSteps: ["Fix the regression"] })} />);
    expect(screen.getByText("Verification: Failed")).toBeInTheDocument();
    for (const text of ["Findings", "File path", "src/a.ts", "0", "false", "null", "[]", "{}", '""', "Next steps", "Fix the regression"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("unwraps serialized reports and nested tool content strings", () => {
    const report = { content: [{ type: "text", text: JSON.stringify({ summary: "Nested report" }) }], isError: false };
    render(<AgentMessageText text={JSON.stringify(JSON.stringify(report))} />);
    expect(screen.getByText("Nested report")).toBeInTheDocument();
    expect(screen.getByText("Is error")).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
  });

  it("renders top-level report arrays without dropping items", () => {
    render(<AgentMessageText text={JSON.stringify([{ summary: "First report" }, { message: "Second report" }])} />);
    expect(screen.getByText("First report")).toBeInTheDocument();
    expect(screen.getByText("Second report")).toBeInTheDocument();
    fireEvent.click(screen.getByText("View report details"));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps deeply nested and wide data accessible with a JSON fallback", () => {
    const { container } = render(<AgentMessageText text={JSON.stringify({
      nested: { a: { b: { c: { d: { e: { f: "Deep evidence" } } } } } },
      entries: Array.from({ length: 101 }, (_, i) => `Evidence ${i}`),
    })} />);
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(container.textContent).toContain("Deep evidence");
    expect(container.textContent).toContain("Evidence 100");
  });

  it("renders JSON as data without executing embedded markup", () => {
    const { container } = render(<AgentMessageText text={JSON.stringify({ summary: '<img src=x onerror="alert(1)">' })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("keeps code examples literal and ordinary Markdown formatted", () => {
    const json = '{"result":"passed","confidence":1}';
    const { container } = render(<AgentMessageText text={`**Example**\n\n\`\`\`json\n${json}\n\`\`\``} />);
    expect(screen.queryByLabelText("Verification result")).not.toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe(json);
    expect(screen.getByText("Example").tagName).toBe("STRONG");
  });
});
