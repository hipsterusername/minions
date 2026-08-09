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
    expect(screen.queryByPlaceholderText(/npx -y/i)).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /prefill form/i }),
    ).not.toBeNull();
  });

  it("hides the manual-fields ID input by default when adding", () => {
    render(<FormHost isNew />);
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
    expect(screen.queryByRole("button", { name: /advanced/i })).toBeNull();
    expect(screen.queryByDisplayValue("filesystem")).not.toBeNull();
  });

  it("auto-expands Advanced after a successful paste-prefill", () => {
    render(<FormHost isNew />);

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

    expect(
      screen.getByRole("button", { name: /advanced/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    expect(screen.queryByDisplayValue("npx")).not.toBeNull();
    expect(screen.queryByText(/prefilled/i)).not.toBeNull();
  });

  it("shows the parser error inline when a paste cannot be parsed", () => {
    render(<FormHost isNew />);
    const textarea = screen.getByPlaceholderText(/npx -y/i);
    fireEvent.change(textarea, { target: { value: "npx foo | grep bar" } });
    fireEvent.click(screen.getByRole("button", { name: /prefill form/i }));

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
