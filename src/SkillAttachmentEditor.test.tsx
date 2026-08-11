import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillAttachmentEditor } from "./SkillAttachmentEditor.tsx";

describe("SkillAttachmentEditor", () => {
  it("adds a supported text document", async () => {
    const onChange = vi.fn();
    render(<SkillAttachmentEditor attachments={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Skill context files"), {
      target: { files: [new File(["# Rules"], "rules.md", { type: "text/markdown" })] },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ filename: "rules.md", text: "# Rules" }),
    ]));
  });

  it("surfaces unsupported files without throwing or mutating", async () => {
    const onChange = vi.fn();
    render(<SkillAttachmentEditor attachments={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Skill context files"), {
      target: { files: [new File(["zip"], "archive.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be attached");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes an attached context item", () => {
    const onChange = vi.fn();
    render(<SkillAttachmentEditor attachments={[{
      kind: "text", filename: "rules.md", mediaType: "text/markdown",
      text: "rules", truncated: false,
    }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove rules.md" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
