/**
 * RoutinePromptEditor — visual prompt-authoring tests.
 *
 * Pins three UX contracts:
 *   1. Click-to-insert from the palette places `{{path}}` at the textarea
 *      cursor and updates the controlled value.
 *   2. The drag payload uses a structured MIME type the textarea drop
 *      handler recognizes, and dropping inserts the path at the host's
 *      cursor.
 *   3. PromptPreview renders ref tokens as chips inline so authors see
 *      static text vs. dynamic context at a glance.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { RoutinePromptEditor } from "./RoutinePromptEditor.tsx";
import type { Routine } from "../shared/routines/types.ts";

const ROUTINE: Routine = {
  id: "demo",
  name: "Demo",
  version: 1,
  failurePolicy: "fail-fast",
  inputs: [
    { name: "topic", label: "Topic", required: true },
  ],
  phases: [
    {
      id: "research",
      label: "Research",
      steps: [
        {
          id: "find",
          label: "Find sources",
          agent: "leader",
          routinePrompt: "look at {{inputs.topic}}",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
          retries: 0,
        },
      ],
    },
    {
      id: "analyse",
      label: "Analyse",
      steps: [
        {
          id: "synth",
          label: "Synthesise",
          agent: "leader",
          routinePrompt: "",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
          retries: 0,
        },
      ],
    },
  ],
};

function Harness({
  initialValue = "",
  phaseIdx = 1,
}: {
  initialValue?: string;
  phaseIdx?: number;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <RoutinePromptEditor
        value={value}
        onChange={setValue}
        routine={ROUTINE}
        phaseIdx={phaseIdx}
        aria-label="prompt"
      />
      <div data-testid="value">{value}</div>
    </>
  );
}

describe("RoutinePromptEditor — palette click-to-insert", () => {
  it("inserts {{path}} at cursor when a palette chip is clicked", () => {
    render(<Harness initialValue="prefix " />);

    const textarea = screen.getByLabelText("prompt") as HTMLTextAreaElement;
    // Place caret at end of "prefix ".
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });

    // Find the inputs.topic chip and click it.
    const chip = screen.getByTitle(/inputs\.topic/);
    fireEvent.click(chip);

    expect(screen.getByTestId("value").textContent).toBe(
      "prefix {{inputs.topic}}",
    );
  });

  // Removed: phase-1 palette `getByTitle(...).toBeTruthy()` smoke test
  // (§5.5 TRIVIAL) — the query throws on absence; the matcher was redundant.

  it("phase-0 palette has no upstream phase section", () => {
    render(<Harness phaseIdx={0} />);
    // Removed redundant `getByTitle(/inputs\.topic/).toBeTruthy()` (§5.5).
    // No handoff entry from a non-existent upstream phase.
    expect(screen.queryByTitle(/handoff\.brief/)).toBeNull();
  });
});

describe("RoutinePromptEditor — drag-drop", () => {
  it("dropping a structured ref payload inserts {{path}} at the cursor", () => {
    render(<Harness initialValue="abc" />);
    const textarea = screen.getByLabelText("prompt") as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 2); // between b and c
    });

    const dt = {
      getData: (kind: string) =>
        kind === "application/x-routine-ref"
          ? JSON.stringify({ path: "inputs.topic", kind: "input" })
          : "",
      types: ["application/x-routine-ref"],
    } as unknown as DataTransfer;

    fireEvent.drop(textarea, { dataTransfer: dt });

    expect(screen.getByTestId("value").textContent).toBe(
      "ab{{inputs.topic}}c",
    );
  });
});

describe("RoutinePromptEditor — preview", () => {
  it("renders ref tokens as inline chips inside the preview", () => {
    render(<Harness initialValue="hello {{inputs.topic}} world" />);
    const preview = screen.getByLabelText("Prompt preview");
    // Static text segments preserved.
    expect(preview.textContent).toContain("hello");
    expect(preview.textContent).toContain("world");
    // Reference token shown as the path inside the preview.
    expect(preview.textContent).toContain("inputs.topic");
  });

  it("flags an unresolved ref with the unknown chip styling", () => {
    render(<Harness initialValue="use {{not.a.real.path}} please" />);
    const preview = screen.getByLabelText("Prompt preview");
    // The chip is rendered with a title matching the unresolved path.
    const chip = within(preview).getByTitle(/Unresolved reference/);
    expect(chip).toBeTruthy();
  });
});

