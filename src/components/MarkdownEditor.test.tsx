/**
 * Component tests for MarkdownEditor.
 *
 * jsdom can host CodeMirror but does NOT route synthetic keyboard
 * events through its keymap reliably, so we keep these tests focused on
 * mount / unmount, controlled-value sync, and the wrapper element's
 * data attributes. Keymap behaviour itself is covered by
 * `markdown-keymap.test.ts` against an EditorState directly.
 */
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";

import { MarkdownEditor } from "./MarkdownEditor.tsx";

describe("MarkdownEditor", () => {
  it("renders a wrapper with data-no-drag and data-scroll-capture", () => {
    const { container } = render(
      <MarkdownEditor value="hello" onChange={() => {}} className="probe" />,
    );
    const host = container.querySelector(".probe");
    expect(host).not.toBeNull();
    expect(host).toHaveAttribute("data-no-drag");
    expect(host).toHaveAttribute("data-scroll-capture");
  });

  it("renders a CodeMirror editor inside the host", () => {
    const { container } = render(
      <MarkdownEditor value="hello" onChange={() => {}} className="probe" />,
    );
    // CodeMirror builds a `.cm-editor` root and a `.cm-content`
    // contenteditable child inside the host on mount.
    expect(container.querySelector(".probe .cm-editor")).not.toBeNull();
    expect(container.querySelector(".probe .cm-content")).not.toBeNull();
  });

  it("hydrates the editor with the initial value", () => {
    const { container } = render(
      <MarkdownEditor value="initial doc" onChange={() => {}} className="probe" />,
    );
    const content = container.querySelector(".probe .cm-content");
    // The text shows up as text content in the contenteditable surface.
    expect(content?.textContent).toContain("initial doc");
  });

  it("synchronises external value changes into the editor", () => {
    function Probe() {
      const [v, setV] = useState("first");
      return (
        <>
          <button onClick={() => setV("second")}>swap</button>
          <MarkdownEditor value={v} onChange={() => {}} className="probe" />
        </>
      );
    }
    const { container, getByText } = render(<Probe />);
    expect(container.querySelector(".probe .cm-content")?.textContent).toContain(
      "first",
    );
    act(() => {
      getByText("swap").click();
    });
    expect(container.querySelector(".probe .cm-content")?.textContent).toContain(
      "second",
    );
  });

  it("destroys the CodeMirror view on unmount (no DOM leak)", () => {
    const { container, unmount } = render(
      <MarkdownEditor value="x" onChange={() => {}} className="probe" />,
    );
    expect(container.querySelector(".probe .cm-editor")).not.toBeNull();
    unmount();
    // After unmount the host is gone entirely.
    expect(container.querySelector(".probe")).toBeNull();
  });

  it("ignores the initial value but does not throw if value is empty", () => {
    expect(() =>
      render(<MarkdownEditor value="" onChange={() => {}} />),
    ).not.toThrow();
  });

  it("does not call onChange just from mounting with a value", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="seeded" onChange={onChange} />);
    // The editor's `updateListener` only fires when the document
    // actually changes; just hydrating from the prop must NOT count
    // as a doc change.
    expect(onChange).not.toHaveBeenCalled();
  });
});
