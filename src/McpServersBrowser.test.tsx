/**
 * Behaviour tests for McpServerForm — the paste-first add/edit form.
 *
 * The contract these tests enforce:
 *   1. PasteBox is the primary surface when adding a new server.
 *   2. The "Advanced" disclosure (manual fields) is collapsed by default
 *      when adding a new server, so the user sees the paste box first.
 *   3. The disclosure is expanded when editing — there's no PasteBox to
 *      hide behind, and the user is necessarily working with the fields.
 *   4. A successful paste prefills the draft AND auto-expands Advanced
 *      so the user can review what landed in each field before saving.
 *   5. The disclosure is a real toggle: clicking it opens/closes.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { McpServerForm } from "./McpServersBrowser.tsx";

type Draft = Parameters<typeof McpServerForm>[0]["draft"];

function emptyDraft(): Draft {
  return {
    id: "",
    name: "",
    description: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    toolNames: "",
  };
}

function populatedDraft(): Draft {
  return {
    id: "filesystem",
    name: "Filesystem",
    description: "Local fs",
    transport: "stdio",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem",
    env: "",
    url: "",
    headers: "",
    toolNames: "",
  };
}

/**
 * Lightweight host that mirrors how McpServersBrowser actually uses
 * McpServerForm — holds the draft state and forwards changes.
 */
function FormHost(props: { isNew: boolean; initial?: Draft }) {
  const [draft, setDraft] = useState<Draft>(props.initial ?? emptyDraft());
  return (
    <McpServerForm
      draft={draft}
      isNew={props.isNew}
      saving={false}
      error=""
      onChange={setDraft}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
}

describe("McpServerForm — paste-first UX", () => {
  it("shows the paste box when adding a new server", () => {
    render(<FormHost isNew />);
    // The textarea placeholder leads with `npx` — that's our paste prompt.
    // We assert presence via queryBy* so the matcher carries information
    // (getBy* would already throw if missing — see §6.3 banned-assertions).
    expect(screen.queryByPlaceholderText(/npx -y/i)).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /prefill form/i }),
    ).not.toBeNull();
  });

  it("hides the manual-fields ID input by default when adding", () => {
    render(<FormHost isNew />);
    // The ID input lives inside the Advanced disclosure; it should not be
    // visible until the user expands the section.
    expect(screen.queryByPlaceholderText("my-server")).toBeNull();
  });

  it("shows an Advanced toggle when adding", () => {
    render(<FormHost isNew />);
    const toggle = screen.getByRole("button", { name: /advanced/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the Advanced section when the toggle is clicked", () => {
    render(<FormHost isNew />);
    const toggle = screen.getByRole("button", { name: /advanced/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByPlaceholderText("my-server")).not.toBeNull();
  });

  it("does NOT show the paste box when editing", () => {
    render(<FormHost isNew={false} initial={populatedDraft()} />);
    expect(screen.queryByPlaceholderText(/npx -y/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /prefill form/i }),
    ).toBeNull();
  });

  it("opens the manual fields by default when editing", () => {
    render(<FormHost isNew={false} initial={populatedDraft()} />);
    // No Advanced toggle in edit mode — fields are just visible.
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
    expect(screen.queryByDisplayValue("filesystem")).not.toBeNull();
  });

  it("auto-expands Advanced after a successful paste-prefill", () => {
    render(<FormHost isNew />);

    // Sanity: Advanced starts collapsed.
    expect(
      screen.getByRole("button", { name: /advanced/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");

    const textarea = screen.getByPlaceholderText(/npx -y/i);
    fireEvent.change(textarea, {
      target: {
        value: "npx -y @modelcontextprotocol/server-filesystem ~/Documents",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /prefill form/i }));

    // After paste: Advanced expanded so user can review the prefilled fields.
    expect(
      screen.getByRole("button", { name: /advanced/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    // And the prefilled command landed in the form.
    expect(screen.queryByDisplayValue("npx")).not.toBeNull();
    // Confirmation surfaces.
    expect(screen.queryByText(/prefilled/i)).not.toBeNull();
  });

  it("shows the parser error inline when a paste cannot be parsed", () => {
    render(<FormHost isNew />);
    const textarea = screen.getByPlaceholderText(/npx -y/i);
    fireEvent.change(textarea, { target: { value: "npx foo | grep bar" } });
    fireEvent.click(screen.getByRole("button", { name: /prefill form/i }));

    // Error mentions metacharacter rejection; Advanced stays collapsed
    // because the paste did not succeed.
    expect(screen.queryByText(/metacharacter/i)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /advanced/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
  });

  it("disables the Prefill button when the textarea is empty", () => {
    render(<FormHost isNew />);
    const button = screen.getByRole("button", { name: /prefill form/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("forwards a parsed draft through onChange", () => {
    const onChange = vi.fn();
    render(
      <McpServerForm
        draft={emptyDraft()}
        isNew
        saving={false}
        error=""
        onChange={onChange}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/npx -y/i);
    fireEvent.change(textarea, {
      target: {
        value:
          "claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /prefill form/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Draft | undefined;
    expect(next?.id).toBe("filesystem");
    expect(next?.command).toBe("npx");
    expect(next?.transport).toBe("stdio");
  });
});
