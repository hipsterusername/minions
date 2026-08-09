/**
 * Component test for HeaderMenu — the ⋮ kebab in the leader-card header.
 *
 * Focus: the "Open System Model" action added so a leader can spawn a
 * System Model node preloaded with its own session key.
 *   - The item appears only when a session key exists and a handler is wired.
 *   - Clicking it fires onOpenSystemModel and closes the menu.
 *   - It is hidden when the leader has no session key yet.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HeaderMenu } from "./HeaderMenu.tsx";
import { LEADER_DEFAULT_DATA, type LeaderData } from "./types.ts";

function dataWith(overrides: Partial<LeaderData>): LeaderData {
  return { ...LEADER_DEFAULT_DATA, ...overrides };
}

const noop = () => {};

describe("HeaderMenu — Open System Model", () => {
  it("opens a System Model node preloaded with the session and closes the menu", () => {
    const onOpenSystemModel = vi.fn();
    render(
      <HeaderMenu
        onReset={noop}
        onExportLog={noop}
        onOpenSystemModel={onOpenSystemModel}
        data={dataWith({ sessionKey: "leader-1", status: "idle" })}
      />,
    );

    // Menu starts closed.
    expect(screen.queryByRole("button", { name: /open system model/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /more leader actions/i }));
    const item = screen.getByRole("menuitem", { name: /open system model/i });
    fireEvent.click(item);

    expect(onOpenSystemModel).toHaveBeenCalledTimes(1);
    // Menu closed again after the action.
    expect(screen.queryByRole("menuitem", { name: /open system model/i })).toBeNull();
  });

  it("hides the action when the leader has no session key", () => {
    render(
      <HeaderMenu
        onReset={noop}
        onExportLog={noop}
        onOpenSystemModel={vi.fn()}
        data={dataWith({ sessionKey: null })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /more leader actions/i }));
    expect(screen.queryByRole("menuitem", { name: /open system model/i })).toBeNull();
  });

  it("hides the action when no handler is provided", () => {
    render(
      <HeaderMenu
        onReset={noop}
        onExportLog={noop}
        data={dataWith({ sessionKey: "leader-1" })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /more leader actions/i }));
    expect(screen.queryByRole("menuitem", { name: /open system model/i })).toBeNull();
  });

  it("focuses the menu and returns focus to the trigger on Escape", async () => {
    render(
      <HeaderMenu
        onReset={() => {}}
        onExportLog={() => {}}
        data={dataWith({})}
      />,
    );

    const trigger = screen.getByRole("button", { name: /more leader actions/i });
    fireEvent.click(trigger);

    const firstItem = await screen.findByRole("menuitem", { name: /export log/i });
    await waitFor(() => expect(firstItem).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: /leader actions/i })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
