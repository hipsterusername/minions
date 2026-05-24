/**
 * ProjectTree behaviour tests.
 *
 *  - filterActive toggle must not throw a hooks error (regression: the early
 *    return that hides untouched rows previously sat between `useState` and
 *    a long block of `useCallback`s, violating the rules of hooks and
 *    crashing React with "Rendered fewer hooks than expected").
 *  - The `query` prop fuzzy-filters the tree in place: only matching paths
 *    and their ancestor directories remain visible, and matching directories
 *    auto-expand so their hits are revealed.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";

import { ProjectTree, type LeaderActivity } from "./ProjectTree.tsx";
import type { TreeNode } from "../api.ts";

const tree: TreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "dir",
    children: [
      { name: "touched.ts", path: "src/touched.ts", type: "file" },
      { name: "untouched.ts", path: "src/untouched.ts", type: "file" },
      {
        name: "nested",
        path: "src/nested",
        type: "dir",
        children: [
          { name: "deep.ts", path: "src/nested/deep.ts", type: "file" },
        ],
      },
    ],
  },
  { name: "README.md", path: "README.md", type: "file" },
];

const leaders: LeaderActivity[] = [
  {
    id: "leader-1",
    name: "Leader 1",
    colorIndex: 0,
    status: "running",
    files: ["src/touched.ts"],
  },
];

describe("ProjectTree filterActive toggle", () => {
  it("toggles filterActive without throwing a rules-of-hooks error", () => {
    function Harness(): React.ReactElement {
      const [filterActive, setFilterActive] = useState(false);
      return (
        <>
          <button onClick={() => setFilterActive(v => !v)}>toggle</button>
          <ProjectTree
            tree={tree}
            rootName="proj"
            leaders={leaders}
            filterActive={filterActive}
          />
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText("touched.ts")).toBeInTheDocument();
    expect(screen.getByText("untouched.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByText("toggle"));

    expect(screen.getByText("touched.ts")).toBeInTheDocument();
    expect(screen.queryByText("untouched.ts")).toBeNull();
    expect(screen.queryByText("README.md")).toBeNull();

    fireEvent.click(screen.getByText("toggle"));
    expect(screen.getByText("untouched.ts")).toBeInTheDocument();
  });

  it("keeps active ancestor directories visible for normalized absolute file paths", () => {
    const absoluteLeaders: LeaderActivity[] = [
      {
        id: "leader-1",
        name: "Leader 1",
        colorIndex: 0,
        status: "running",
        files: ["/repo/src/nested/deep.ts"],
      },
    ];

    render(
      <ProjectTree
        tree={tree}
        rootName="proj"
        leaders={absoluteLeaders}
        projectPath="/repo"
        filterActive
      />,
    );

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("nested")).toBeInTheDocument();
    expect(screen.getByText("deep.ts")).toBeInTheDocument();
    expect(screen.queryByText("touched.ts")).toBeNull();
    expect(screen.queryByText("README.md")).toBeNull();
  });
});

describe("ProjectTree query filter", () => {
  it("renders every node when the query is empty", () => {
    render(
      <ProjectTree tree={tree} rootName="proj" leaders={[]} query="" />,
    );
    expect(screen.getByText("touched.ts")).toBeInTheDocument();
    expect(screen.getByText("untouched.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("hides non-matching files when a query is set", () => {
    render(
      <ProjectTree tree={tree} rootName="proj" leaders={[]} query="touched" />,
    );
    expect(screen.getByText("touched.ts")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).toBeNull();
    // 'untouched.ts' fuzzy-matches "touched" too — both share the substring,
    // so it must remain visible. This pins the matcher's permissive nature.
    expect(screen.getByText("untouched.ts")).toBeInTheDocument();
  });

  it("hides parent directories when no descendant matches", () => {
    render(
      <ProjectTree tree={tree} rootName="proj" leaders={[]} query="readme" />,
    );
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // The src/ directory has no matching descendants → entirely hidden.
    expect(screen.queryByText("src")).toBeNull();
    expect(screen.queryByText("touched.ts")).toBeNull();
  });

  it("auto-expands matched directories so their hits are visible", () => {
    // The nested file matches; nested/ and src/ are both pulled in as
    // ancestors and must be expanded to reveal deep.ts.
    render(
      <ProjectTree tree={tree} rootName="proj" leaders={[]} query="deep" />,
    );
    expect(screen.getByText("deep.ts")).toBeInTheDocument();
    expect(screen.getByText("nested")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("ignores whitespace-only queries", () => {
    render(
      <ProjectTree tree={tree} rootName="proj" leaders={[]} query="   " />,
    );
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("untouched.ts")).toBeInTheDocument();
  });

  it("does not crash when typing a query after the first render", () => {
    function Harness(): React.ReactElement {
      const [q, setQ] = useState("");
      return (
        <>
          <input
            aria-label="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ProjectTree tree={tree} rootName="proj" leaders={[]} query={q} />
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("q"), { target: { value: "deep" } });
    expect(screen.getByText("deep.ts")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).toBeNull();
    fireEvent.change(screen.getByLabelText("q"), { target: { value: "" } });
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });
});
