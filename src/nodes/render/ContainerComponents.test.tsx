/**
 * Component tests for SectionRenderer and TabsRenderer.
 *
 * Tests verify:
 *   - open/close toggle, defaultOpen seeding, and global expand/collapse (SectionRenderer)
 *   - tab switching, activeTabId seeding, renderChild call counts (TabsRenderer)
 *   - ARIA attributes (aria-expanded, role=tablist, aria-selected)
 *   - keyboard arrow-key navigation (TabsRenderer)
 *   - badge rendering on both containers
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { SectionRenderer, TabsRenderer } from "./ContainerComponents.tsx";
import type { SectionComponent, TabsComponent } from "../../../shared/render-containers.ts";
import type { RenderComponent } from "../../../shared/render-dsl.ts";

// ── Test helpers ───────────────────────────────────────────

/** Minimal text component for use as a child. */
function textChild(id: string): RenderComponent {
  return { id, type: "text", content: `Content of ${id}` };
}

/**
 * Returns a vi mock that renders a uniquely identifiable element per child.
 * Cast is safe: Mock<F> structurally satisfies F.
 */
function makeRenderChild(): (child: RenderComponent) => ReactElement {
  return vi.fn((child: RenderComponent): ReactElement => (
    <div data-testid={`child-${child.id}`}>{child.id}</div>
  )) as unknown as (child: RenderComponent) => ReactElement;
}

// ── SectionRenderer ────────────────────────────────────────

describe("SectionRenderer", () => {
  it("renders the section title", () => {
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "My Section",
      components: [],
    };
    render(<SectionRenderer c={c} renderChild={makeRenderChild()} />);
    expect(screen.getByText("My Section")).toBeInTheDocument();
  });

  it("does not render children by default (defaultOpen omitted -> false)", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Default Closed",
      components: [textChild("c1"), textChild("c2")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("child-c2")).not.toBeInTheDocument();
  });

  it("renders children when defaultOpen is true", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Default Open",
      defaultOpen: true,
      components: [textChild("c1"), textChild("c2")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(screen.getByTestId("child-c1")).toBeInTheDocument();
    expect(screen.getByTestId("child-c2")).toBeInTheDocument();
  });

  it("does not render children when defaultOpen is false", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Closed",
      defaultOpen: false,
      components: [textChild("c1")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();
    expect(vi.mocked(renderChild as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("header click closes an open section", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Toggle",
      defaultOpen: true,
      components: [textChild("c1")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(screen.getByTestId("child-c1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();
  });

  it("header click opens a closed section", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Toggle",
      defaultOpen: false,
      components: [textChild("c1")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("child-c1")).toBeInTheDocument();
  });

  it("aria-expanded tracks open/closed state", () => {
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "ARIA",
      defaultOpen: false,
      components: [],
    };
    render(<SectionRenderer c={c} renderChild={makeRenderChild()} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("renders badge text when provided", () => {
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "With Badge",
      badge: "42",
      components: [],
    };
    render(<SectionRenderer c={c} renderChild={makeRenderChild()} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("calls renderChild exactly once per visible child", () => {
    const renderChild = makeRenderChild();
    const spy = renderChild as unknown as ReturnType<typeof vi.fn>;
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Three Children",
      defaultOpen: true,
      components: [textChild("c1"), textChild("c2"), textChild("c3")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not call renderChild for children when section is closed", () => {
    const renderChild = makeRenderChild();
    const spy = renderChild as unknown as ReturnType<typeof vi.fn>;
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Closed Section",
      defaultOpen: false,
      components: [textChild("c1"), textChild("c2")],
    };
    render(<SectionRenderer c={c} renderChild={renderChild} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("responds to dashboard-level expand/collapse state", () => {
    const renderChild = makeRenderChild();
    const c: SectionComponent = {
      id: "s1",
      type: "section",
      title: "Global Toggle",
      components: [textChild("c1")],
    };
    const { rerender } = render(
      <SectionRenderer c={c} renderChild={renderChild} globalOpenState={false} />,
    );
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();

    rerender(<SectionRenderer c={c} renderChild={renderChild} globalOpenState={true} />);
    expect(screen.getByTestId("child-c1")).toBeInTheDocument();

    rerender(<SectionRenderer c={c} renderChild={renderChild} globalOpenState={false} />);
    expect(screen.queryByTestId("child-c1")).not.toBeInTheDocument();
  });
});

// ── TabsRenderer ───────────────────────────────────────────

const twoTabComponent: TabsComponent = {
  id: "t1",
  type: "tabs",
  tabs: [
    { id: "tab-a", label: "Tab A", components: [textChild("ca1")] },
    { id: "tab-b", label: "Tab B", components: [textChild("cb1"), textChild("cb2")] },
  ],
};

describe("TabsRenderer", () => {
  it("renders all tab labels", () => {
    render(<TabsRenderer c={twoTabComponent} renderChild={makeRenderChild()} />);
    expect(screen.getByText("Tab A")).toBeInTheDocument();
    expect(screen.getByText("Tab B")).toBeInTheDocument();
  });

  it("shows the first tab's children by default", () => {
    const renderChild = makeRenderChild();
    render(<TabsRenderer c={twoTabComponent} renderChild={renderChild} />);
    expect(screen.getByTestId("child-ca1")).toBeInTheDocument();
    expect(screen.queryByTestId("child-cb1")).not.toBeInTheDocument();
  });

  it("seeds initial active tab from activeTabId prop", () => {
    const renderChild = makeRenderChild();
    const c: TabsComponent = { ...twoTabComponent, activeTabId: "tab-b" };
    render(<TabsRenderer c={c} renderChild={renderChild} />);
    expect(screen.queryByTestId("child-ca1")).not.toBeInTheDocument();
    expect(screen.getByTestId("child-cb1")).toBeInTheDocument();
  });

  it("clicking a tab switches to its content", () => {
    const renderChild = makeRenderChild();
    render(<TabsRenderer c={twoTabComponent} renderChild={renderChild} />);

    fireEvent.click(screen.getByText("Tab B"));
    expect(screen.queryByTestId("child-ca1")).not.toBeInTheDocument();
    expect(screen.getByTestId("child-cb1")).toBeInTheDocument();
    expect(screen.getByTestId("child-cb2")).toBeInTheDocument();
  });

  it("only calls renderChild for the active tab's children", () => {
    const renderChild = makeRenderChild();
    const spy = renderChild as unknown as ReturnType<typeof vi.fn>;
    render(<TabsRenderer c={twoTabComponent} renderChild={renderChild} />);
    // Tab A has 1 child; Tab B has 2. Default is Tab A.
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Tab B"));
    // After switching, cumulative call count is 1 + 2 = 3.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("renders badge on a tab when provided", () => {
    const c: TabsComponent = {
      id: "t1",
      type: "tabs",
      tabs: [
        { id: "tab-a", label: "Tab A", badge: "5", components: [] },
        { id: "tab-b", label: "Tab B", components: [] },
      ],
    };
    render(<TabsRenderer c={c} renderChild={makeRenderChild()} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("tablist and tab ARIA roles are present", () => {
    render(<TabsRenderer c={twoTabComponent} renderChild={makeRenderChild()} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("active tab has aria-selected=true; inactive tabs have aria-selected=false", () => {
    render(<TabsRenderer c={twoTabComponent} renderChild={makeRenderChild()} />);
    const [tabA, tabB] = screen.getAllByRole("tab");
    expect(tabA).toHaveAttribute("aria-selected", "true");
    expect(tabB).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tabB!);
    expect(tabA).toHaveAttribute("aria-selected", "false");
    expect(tabB).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowRight key moves to the next tab", () => {
    render(<TabsRenderer c={twoTabComponent} renderChild={makeRenderChild()} />);
    const tabs = screen.getAllByRole("tab");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(screen.queryByTestId("child-ca1")).not.toBeInTheDocument();
    expect(screen.getByTestId("child-cb1")).toBeInTheDocument();
  });

  it("ArrowLeft key wraps around to the last tab from the first", () => {
    render(<TabsRenderer c={twoTabComponent} renderChild={makeRenderChild()} />);
    const tabs = screen.getAllByRole("tab");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    // Wrapping from index 0 left should land on the last tab (tab-b).
    expect(screen.queryByTestId("child-ca1")).not.toBeInTheDocument();
    expect(screen.getByTestId("child-cb1")).toBeInTheDocument();
  });
});
