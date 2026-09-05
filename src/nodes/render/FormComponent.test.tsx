/**
 * Component tests for FormComponent.
 *
 * Covers:
 *   1. All field kinds render with their labels.
 *   2. Required field blocks submit; error message shown.
 *   3. Pattern mismatch blocks submit.
 *   4. Valid submit calls onSubmit with merged answers.
 *   5. When submittedAnswers is set, fields are disabled and submit is absent.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormComponent } from "./FormComponent.tsx";
import type { FormComponent as FormComponentType } from "../../../shared/render-form.ts";

// ── Fixtures ───────────────────────────────────────────────

const allKindsForm: FormComponentType = {
  id: "all-kinds",
  type: "form",
  title: "All Fields",
  fields: [
    { id: "f-text", kind: "text", label: "Text field" },
    { id: "f-textarea", kind: "textarea", label: "Textarea field" },
    { id: "f-number", kind: "number", label: "Number field" },
    {
      id: "f-select",
      kind: "select",
      label: "Select field",
      options: ["alpha", "beta"],
    },
    {
      id: "f-multiselect",
      kind: "multiselect",
      label: "Multiselect field",
      options: ["x", "y", "z"],
    },
    {
      id: "f-slider",
      kind: "slider",
      label: "Slider field",
      min: 0,
      max: 100,
      default: 50,
    },
    { id: "f-checkbox", kind: "checkbox", label: "Checkbox field" },
    { id: "f-date", kind: "date", label: "Date field" },
  ],
};

const requiredTextField: FormComponentType = {
  id: "req",
  type: "form",
  fields: [{ id: "name", kind: "text", label: "Name", required: true }],
};

const patternForm: FormComponentType = {
  id: "pat",
  type: "form",
  fields: [
    {
      id: "code",
      kind: "text",
      label: "Code",
      pattern: "^[A-Z]{3}$",
      placeholder: "ABC",
    },
  ],
};

const submittedForm: FormComponentType = {
  id: "done",
  type: "form",
  title: "Survey",
  fields: [
    { id: "q1", kind: "text", label: "Question 1" },
    { id: "q2", kind: "select", label: "Question 2", options: ["yes", "no"] },
  ],
  submittedAnswers: { q1: "my answer", q2: "yes" },
};

// ── Test 1: all field kinds render ─────────────────────────

describe("FormComponent — field rendering", () => {
  it("renders labels for all field kinds", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/Text field/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Textarea field/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Number field/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Select field/)).toBeInTheDocument();
    // multiselect renders individual checkbox labels
    expect(screen.getByText("Multiselect field")).toBeInTheDocument();
    expect(screen.getByLabelText(/Slider field/)).toBeInTheDocument();
    expect(screen.getByText("Date field")).toBeInTheDocument();
  });

  it("renders select options in the dropdown", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);
    const select = screen.getByLabelText(/Select field/) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain("alpha");
    expect(optionValues).toContain("beta");
  });

  it("renders multiselect options as checkboxes", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);
    // Each option in the multiselect appears as its own checkbox label
    expect(screen.getByText("x")).toBeInTheDocument();
    expect(screen.getByText("y")).toBeInTheDocument();
    expect(screen.getByText("z")).toBeInTheDocument();
  });

  it("renders slider with current value display", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);
    // The slider default is 50; it should display that value
    expect(screen.getByText("50")).toBeInTheDocument();
  });

  it("renders a submit button by default", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("renders custom submitLabel", () => {
    const form: FormComponentType = { ...allKindsForm, submitLabel: "Deploy" };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
  });

  it("renders form title in the header when provided", () => {
    render(<FormComponent component={allKindsForm} onSubmit={vi.fn()} />);
    expect(screen.getByText("All Fields")).toBeInTheDocument();
  });
});

// ── Test 2: required field blocks submit ───────────────────

describe("FormComponent — required validation", () => {
  it("shows error and does not call onSubmit when required text field is empty", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={requiredTextField} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toMatch(/required/i);
  });

  it("links validation errors and descriptions to the invalid input", () => {
    const form: FormComponentType = {
      id: "described-required",
      type: "form",
      fields: [
        {
          id: "name",
          kind: "text",
          label: "Name",
          description: "Used on generated reports.",
          required: true,
        },
      ],
    };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const input = screen.getByLabelText(/Name/);
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(/Used on generated reports\..*Name is required/);
    expect(input).toHaveAttribute("aria-describedby", `${input.id}-description ${input.id}-error`);
  });

  it("clears the error and calls onSubmit after valid input", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={requiredTextField} onSubmit={onSubmit} />);

    const input = screen.getByLabelText(/Name/);
    fireEvent.change(input, { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error for required multiselect with no selections", () => {
    const form: FormComponentType = {
      id: "ms",
      type: "form",
      fields: [
        {
          id: "tags",
          kind: "multiselect",
          label: "Tags",
          required: true,
          options: ["a", "b"],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: /Tags/ });
    expect(group).toBeInvalid();
    expect(group).toHaveAccessibleDescription(/Tags requires at least one selection/);
  });

  it("shows an error for required checkbox left unchecked", () => {
    const form: FormComponentType = {
      id: "chk",
      type: "form",
      fields: [{ id: "agree", kind: "checkbox", label: "Agree", required: true }],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

// ── Test 3: pattern mismatch ───────────────────────────────

describe("FormComponent — pattern validation", () => {
  it("blocks submit when value does not match pattern", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={patternForm} onSubmit={onSubmit} />);

    const input = screen.getByLabelText(/Code/);
    fireEvent.change(input, { target: { value: "abc" } }); // lowercase, fails ^[A-Z]{3}$
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toMatch(/format/i);
  });

  it("allows submit when value matches pattern", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={patternForm} onSubmit={onSubmit} />);

    const input = screen.getByLabelText(/Code/);
    fireEvent.change(input, { target: { value: "ABC" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("skips pattern check when field is empty and not required", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={patternForm} onSubmit={onSubmit} />);

    // Leave field empty — not required, pattern only checked when non-empty
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

// ── Test 4: onSubmit called with merged answers ────────────

describe("FormComponent — submit payload", () => {
  it("calls onSubmit with the field values keyed by field id", () => {
    const form: FormComponentType = {
      id: "s",
      type: "form",
      fields: [
        { id: "color", kind: "text", label: "Favorite color", default: "" },
        { id: "agree", kind: "checkbox", label: "I agree", default: false },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Favorite color/), {
      target: { value: "blue" },
    });
    fireEvent.click(screen.getByLabelText(/I agree/));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ color: "blue", agree: true }),
    );
  });

  it("includes default values for untouched fields in the payload", () => {
    const form: FormComponentType = {
      id: "d",
      type: "form",
      fields: [
        { id: "n", kind: "number", label: "Num", default: 42 },
        { id: "t", kind: "text", label: "Text", default: "hi" },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["n"]).toBe(42);
    expect(payload["t"]).toBe("hi");
  });

  it("includes multiselect array in payload", () => {
    const form: FormComponentType = {
      id: "ms",
      type: "form",
      fields: [
        {
          id: "tags",
          kind: "multiselect",
          label: "Tags",
          options: ["a", "b", "c"],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    // Click the "a" and "c" checkboxes inside the multiselect group
    fireEvent.click(screen.getByLabelText("a"));
    fireEvent.click(screen.getByLabelText("c"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["tags"]).toEqual(["a", "c"]);
  });
});

// ── Test 5: locked state when submittedAnswers is set ──────

describe("FormComponent — locked (submitted) state", () => {
  it("disables all inputs when submittedAnswers is set", () => {
    render(<FormComponent component={submittedForm} onSubmit={vi.fn()} />);

    // All inputs should be disabled
    const inputs = screen.getAllByRole("textbox");
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
    const selects = screen.queryAllByRole("combobox");
    for (const select of selects) {
      expect(select).toBeDisabled();
    }
  });

  it("does not render a submit button when locked", () => {
    render(<FormComponent component={submittedForm} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });

  it("shows a 'Submitted' badge when locked", () => {
    render(<FormComponent component={submittedForm} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Response received ✓/)).toBeInTheDocument();
  });

  it("pre-fills inputs with submitted answer values", () => {
    render(<FormComponent component={submittedForm} onSubmit={vi.fn()} />);
    const textInput = screen.getByDisplayValue("my answer");
    expect(textInput).toBeInTheDocument();
  });
});

// ── Test 6: optimistic feedback on submit ──────────────────

describe("FormComponent — authoritative submit feedback", () => {
  const simpleForm: FormComponentType = {
    id: "fb",
    type: "form",
    title: "Quick question",
    fields: [{ id: "answer", kind: "text", label: "Answer", default: "hi" }],
  };

  it("locks the form without claiming receipt after a valid submit", () => {
    render(<FormComponent component={simpleForm} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    // Submit button is gone, confirmation is shown, badge appears.
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    expect(screen.getByText(/Sending response/)).toBeInTheDocument();
    expect(screen.queryByText(/Response received/)).toBeNull();
    expect(screen.getByLabelText(/Answer/)).toBeDisabled();
  });

  it("does NOT lock or acknowledge when validation fails", () => {
    const form: FormComponentType = {
      id: "reqfb",
      type: "form",
      fields: [{ id: "name", kind: "text", label: "Name", required: true }],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    // Still interactive, no acknowledgement.
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
    expect(screen.queryByText(/the agent has been notified/i)).toBeNull();
    expect(screen.getByLabelText(/Name/)).not.toBeDisabled();
  });

  it("still forwards the answers to onSubmit while locking", () => {
    const onSubmit = vi.fn();
    render(<FormComponent component={simpleForm} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ answer: "hi" });
  });

  it("uses a distinct confirmation copy for agent-locked forms", () => {
    render(<FormComponent component={submittedForm} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Response received ✓/)).toBeInTheDocument();
    expect(screen.queryByText(/the agent has been notified/i)).toBeNull();
  });
});

// ── Test 7: required select pre-selects first option ───────

describe("FormComponent — required select defaulting", () => {
  it("submits the visibly-selected first option when no default is set", () => {
    const form: FormComponentType = {
      id: "reqsel",
      type: "form",
      fields: [
        {
          id: "env",
          kind: "select",
          label: "Environment",
          required: true,
          options: ["staging", "prod"],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    // User does NOT touch the dropdown — the first option is already shown.
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    // No "is required" error, and the first option is submitted.
    expect(screen.queryByText(/is required/i)).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ env: "staging" });
  });

  it("uses the option value (not label) for {value,label} options", () => {
    const form: FormComponentType = {
      id: "reqsel2",
      type: "form",
      fields: [
        {
          id: "region",
          kind: "select",
          label: "Region",
          required: true,
          options: [
            { value: "us-east-1", label: "US East (Recommended)" },
            { value: "eu-west-1", label: "EU West" },
          ],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ region: "us-east-1" });
  });

  it("still honours an explicit default over the first option", () => {
    const form: FormComponentType = {
      id: "reqsel3",
      type: "form",
      fields: [
        {
          id: "env",
          kind: "select",
          label: "Environment",
          required: true,
          default: "prod",
          options: ["staging", "prod"],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ env: "prod" });
  });

  it("leaves an optional select empty (placeholder) by default", () => {
    const form: FormComponentType = {
      id: "optsel",
      type: "form",
      fields: [
        {
          id: "env",
          kind: "select",
          label: "Environment",
          options: ["staging", "prod"],
        },
      ],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    // Optional: empty is allowed and submitted as "".
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ env: "" });
  });
});

// ── Edge cases ─────────────────────────────────────────────

describe("FormComponent — edge cases", () => {
  it("renders without a title when title is omitted", () => {
    const form: FormComponentType = {
      id: "notitle",
      type: "form",
      fields: [{ id: "x", kind: "text", label: "X" }],
    };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);
    // Should not throw; the header section is absent so no title element
    expect(screen.queryByText("notitle")).toBeNull();
  });

  it("renders description text when provided", () => {
    const form: FormComponentType = {
      id: "d",
      type: "form",
      description: "Please fill this out carefully.",
      fields: [],
    };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);
    expect(screen.getByText("Please fill this out carefully.")).toBeInTheDocument();
  });

  it("renders a form with no fields and just a submit button", () => {
    const form: FormComponentType = { id: "empty", type: "form", fields: [] };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it("renders {value, label} select options using the label text", () => {
    const form: FormComponentType = {
      id: "s",
      type: "form",
      fields: [
        {
          id: "region",
          kind: "select",
          label: "Region",
          options: [
            { value: "us-east-1", label: "US East" },
            { value: "eu-west-1", label: "EU West" },
          ],
        },
      ],
    };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);
    const select = screen.getByLabelText(/Region/) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toContain("US East");
    expect(labels).toContain("EU West");
  });

  it("marks required fields with an asterisk in the label", () => {
    render(<FormComponent component={requiredTextField} onSubmit={vi.fn()} />);
    // The required asterisk is rendered as an aria-hidden span
    const label = screen.getByText(/Name/).closest("label");
    expect(label?.textContent).toContain("*");
  });

  it("maxLength validation error is shown when text exceeds limit", () => {
    const form: FormComponentType = {
      id: "ml",
      type: "form",
      fields: [{ id: "bio", kind: "text", label: "Bio", maxLength: 5 }],
    };
    const onSubmit = vi.fn();
    render(<FormComponent component={form} onSubmit={onSubmit} />);

    const input = screen.getByLabelText(/Bio/);
    // Bypass the native maxlength by firing change directly
    fireEvent.change(input, { target: { value: "toolong" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/5/);
  });

  it("multiselect option checkboxes are scoped within the field container", () => {
    const form: FormComponentType = {
      id: "ms-scope",
      type: "form",
      fields: [
        {
          id: "fruits",
          kind: "multiselect",
          label: "Fruits",
          options: ["apple", "banana"],
        },
        // A standalone checkbox field — should NOT appear in the multiselect group
        { id: "solo", kind: "checkbox", label: "solo-checkbox" },
      ],
    };
    render(<FormComponent component={form} onSubmit={vi.fn()} />);

    // "apple" and "banana" labels should be in the DOM
    const appleLabel = screen.getByText("apple");
    const bananaLabel = screen.getByText("banana");
    expect(appleLabel).toBeInTheDocument();
    expect(bananaLabel).toBeInTheDocument();

    // The multiselect group should NOT include the solo-checkbox label
    const fruitsGroup = screen.getByRole("group", { name: "Fruits" });
    const multiGroup = within(fruitsGroup).queryByText("solo-checkbox");
    expect(multiGroup).toBeNull();
  });
});
