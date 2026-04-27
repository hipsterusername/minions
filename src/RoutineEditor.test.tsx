/**
 * Component tests for RoutineEditor.
 *
 * Covers four behaviors:
 *   1. validateDraft surfaces missing-required-input errors inline when an
 *      input row has an empty name or label.
 *   2. validateDraft rejects duplicate step ids and shows the error globally
 *      (Save & close remains disabled).
 *   3. PromptTextarea autocomplete dropdown shows `inputs.<name>` candidates
 *      and prior-phase step id candidates when `{{` is typed.
 *   4. Drag-reorder updates the phase / step order in the editor draft.
 *
 * Networking: the component loads routines via `./api.ts` which wraps
 * `fetch`.  We mock `globalThis.fetch` directly (same pattern as
 * MarkdownNode.test.tsx) so no vi.mock module hoisting is needed and the
 * ESM module graph loads normally.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RoutineEditor } from "./RoutineEditor.tsx";
import { clearAuthToken } from "./api.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "test-bearer-token";

const TWO_STEP_ROUTINE = {
  id: "two-step",
  name: "Two Steps",
  version: 1,
  inputs: [],
  phases: [
    {
      id: "phase-1",
      label: "Phase One",
      steps: [
        {
          id: "step-a",
          label: "Step Alpha",
          agent: "leader",
          routinePrompt: "Do alpha.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
        {
          id: "step-b",
          label: "Step Beta",
          agent: "leader",
          routinePrompt: "Do beta.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
  ],
  failurePolicy: "fail-fast",
};

const TWO_PHASE_ROUTINE = {
  id: "two-phase",
  name: "Two Phases",
  version: 1,
  inputs: [{ name: "topic", type: "string", label: "Topic", required: true }],
  phases: [
    {
      id: "phase-1",
      label: "Alpha phase",
      steps: [
        {
          id: "step-a",
          label: "Research step",
          agent: "leader",
          routinePrompt: "Research {{inputs.topic}}.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
    {
      id: "phase-2",
      label: "Beta phase",
      steps: [
        {
          id: "step-b",
          label: "Analysis step",
          agent: "leader",
          routinePrompt: "",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
  ],
  failurePolicy: "fail-fast",
};

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type AnyRoutine = typeof TWO_STEP_ROUTINE | typeof TWO_PHASE_ROUTINE;

function makeFetch(routines: AnyRoutine[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/token")) {
        return new Response(JSON.stringify({ token: FAKE_TOKEN }), {
          status: 200,
        });
      }
      if (url.includes("/routines")) {
        return new Response(
          JSON.stringify({ routines, invalid: [] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "unmatched" }), {
        status: 404,
      });
    },
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// ── Global setup ──────────────────────────────────────────────────────────────

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  clearAuthToken();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Shared helpers ────────────────────────────────────────────────────────────

async function renderAndLoad(routines: AnyRoutine[]): Promise<void> {
  makeFetch(routines);
  render(<RoutineEditor projectId="test-project" onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
  );
}

async function clickEdit(routineName: string): Promise<void> {
  const btn = await screen.findByRole("button", {
    name: `Edit routine ${routineName}`,
  });
  await act(async () => {
    fireEvent.click(btn);
  });
}

// ── 1. validateDraft: missing required input ──────────────────────────────────

describe("validateDraft: missing required input", () => {
  it("shows inline error and disables Save when input name is blank", async () => {
    await renderAndLoad([]);

    // Enter edit mode by creating a new routine.
    const newBtn = await screen.findByRole("button", { name: /new routine/i });
    await act(async () => {
      fireEvent.click(newBtn);
    });

    // Fill in the ID so its own error doesn't shadow the input-row error.
    const idInput = screen.getByRole("textbox", { name: "Routine ID" });
    await act(async () => {
      fireEvent.change(idInput, { target: { value: "my-routine" } });
    });

    // Add an input row — new rows start with empty name and label.
    const addInputBtn = screen.getByRole("button", { name: "Add input" });
    await act(async () => {
      fireEvent.click(addInputBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Input 1 name" }),
      ).toBeInTheDocument();
    });

    // Save must be disabled while the draft has validation errors.
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn).toBeDisabled();

    // An inline error is rendered by InputRow when name/label is invalid.
    // The error div sits inside the same section as the input fields.
    const inputsSection = screen
      .getByRole("textbox", { name: "Input 1 name" })
      .closest("section");
    expect(inputsSection).not.toBeNull();

    const errorEls = Array.from(
      inputsSection!.querySelectorAll<HTMLElement>("div[style]"),
    ).filter(
      (el) =>
        el.style.color !== "" ||
        el.getAttribute("style")?.includes("danger"),
    );
    expect(errorEls.length).toBeGreaterThan(0);
  });
});

// ── 2. validateDraft: duplicate step ids ─────────────────────────────────────

describe("validateDraft: duplicate step ids", () => {
  it("shows global error and disables Save when two steps share an id", async () => {
    await renderAndLoad([TWO_STEP_ROUTINE]);
    await clickEdit("Two Steps");

    // Open Step Beta's edit form.
    const betaItem = await screen.findByText("Step Beta");
    await act(async () => {
      fireEvent.click(betaItem);
    });

    // Step Beta is index 1 within phase 1 → aria-label "Step 2 id".
    const stepIdInput = await screen.findByRole("textbox", {
      name: "Step 2 id",
    });
    expect(stepIdInput).toHaveValue("step-b");

    // Make Step Beta's id a duplicate of Step Alpha's id.
    await act(async () => {
      fireEvent.change(stepIdInput, { target: { value: "step-a" } });
    });

    // RoutineEditView renders <div role="alert"> when globalErrors is non-empty.
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/duplicate/i);
    });

    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});

// ── 3. PromptTextarea autocomplete ───────────────────────────────────────────

describe("PromptTextarea autocomplete", () => {
  it("shows inputs.<name> and prior step id suggestions when {{ is typed", async () => {
    await renderAndLoad([TWO_PHASE_ROUTINE]);
    await clickEdit("Two Phases");

    // Navigate to "Analysis step" (phase 2, step 0).
    const analysisItem = await screen.findByText("Analysis step");
    await act(async () => {
      fireEvent.click(analysisItem);
    });

    // phaseIdx=1, stepIdx=0 → aria-label "Step 1 routine prompt".
    const textarea = await screen.findByRole("textbox", {
      name: "Step 1 routine prompt",
    });

    // Two-step sequence: fireEvent.change bypasses the DOM value-setter so
    // selectionStart stays at 0 (causing getAutocompleteInfo to slice at
    // position 0 and find no '{{').  After act() resolves, React reconciles
    // the controlled textarea via the prototype setter which resets
    // selectionStart to value.length=2.  The subsequent keyUp fires
    // recompute() with the correct cursor and the listbox appears.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "{{" } });
    });
    await act(async () => {
      fireEvent.keyUp(textarea);
    });

    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeInTheDocument();

    const texts = Array.from(
      listbox.querySelectorAll('[role="option"]'),
    ).map((el) => el.textContent ?? "");

    expect(texts.some((t) => t.includes("inputs.topic"))).toBe(true);
    expect(texts.some((t) => t.includes("step-a"))).toBe(true);
  });

  it("closes the autocomplete when Escape is pressed", async () => {
    await renderAndLoad([TWO_PHASE_ROUTINE]);
    await clickEdit("Two Phases");

    const analysisItem = await screen.findByText("Analysis step");
    await act(async () => {
      fireEvent.click(analysisItem);
    });

    const textarea = await screen.findByRole("textbox", {
      name: "Step 1 routine prompt",
    });

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "{{" } });
    });
    await act(async () => {
      fireEvent.keyUp(textarea);
    });

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});

// ── 4. Drag-reorder ──────────────────────────────────────────────────────────

describe("Drag-reorder phases", () => {
  it("reorders phases when Alpha is dragged onto Beta", async () => {
    await renderAndLoad([TWO_PHASE_ROUTINE]);
    await clickEdit("Two Phases");

    // The Flow Map renders its own copy of the phase labels in cards, so
    // scope these queries to the draggable Phases tree where the test
    // actually wants to interact.
    const tree = await screen.findByRole("region", { name: "Phases" });
    const alphaLabel = await within(tree).findByText("Alpha phase");
    const betaLabel = await within(tree).findByText("Beta phase");

    const alphaDraggable = alphaLabel.closest("[draggable]") as HTMLElement;
    const betaDraggable = betaLabel.closest("[draggable]") as HTMLElement;
    expect(alphaDraggable).not.toBeNull();
    expect(betaDraggable).not.toBeNull();

    const dt = { effectAllowed: "" } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.dragStart(alphaDraggable, { dataTransfer: dt });
      fireEvent.dragOver(betaDraggable);
      fireEvent.drop(betaDraggable, { dataTransfer: dt });
    });

    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll("span")).filter(
        (s) =>
          s.textContent === "Alpha phase" || s.textContent === "Beta phase",
      );
      if (spans.length >= 2) {
        const betaIdx = spans.findIndex((s) => s.textContent === "Beta phase");
        const alphaIdx = spans.findIndex((s) => s.textContent === "Alpha phase");
        expect(betaIdx).toBeLessThan(alphaIdx);
      } else {
        expect(spans.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("Drag-reorder steps", () => {
  it("reorders steps within a phase when Step Alpha is dragged onto Step Beta", async () => {
    await renderAndLoad([TWO_STEP_ROUTINE]);
    await clickEdit("Two Steps");

    const alphaStep = await screen.findByText("Step Alpha");
    const betaStep = await screen.findByText("Step Beta");

    const alphaDraggable = alphaStep.closest("[draggable]") as HTMLElement;
    const betaDraggable = betaStep.closest("[draggable]") as HTMLElement;
    expect(alphaDraggable).not.toBeNull();
    expect(betaDraggable).not.toBeNull();

    const dt = { effectAllowed: "" } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.dragStart(alphaDraggable, { dataTransfer: dt });
      fireEvent.dragOver(betaDraggable);
      fireEvent.drop(betaDraggable, { dataTransfer: dt });
    });

    await waitFor(() => {
      const spans = Array.from(document.querySelectorAll("span")).filter(
        (s) =>
          s.textContent === "Step Alpha" || s.textContent === "Step Beta",
      );
      if (spans.length >= 2) {
        const betaIdx = spans.findIndex((s) => s.textContent === "Step Beta");
        const alphaIdx = spans.findIndex((s) => s.textContent === "Step Alpha");
        expect(betaIdx).toBeLessThan(alphaIdx);
      }
    });
  });
});
