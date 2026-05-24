import { describe, expect, it } from "vitest";
import {
  createMiniMapLayout,
  miniMapPointToWorld,
  miniMapWorldBounds,
  viewportWorldRect,
  worldToMiniMapRect,
} from "./CanvasMiniMap.tsx";
import { makeNode } from "../tests/fixtures/builders.ts";

describe("CanvasMiniMap geometry", () => {
  it("converts the current screen viewport into world coordinates", () => {
    expect(
      viewportWorldRect(
        { x: -200, y: -100, scale: 2 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 100, y: 50, width: 500, height: 400 });
  });

  it("keeps an empty canvas navigable by using the viewport as bounds", () => {
    const bounds = miniMapWorldBounds([], {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });

    expect(bounds.x).toBeLessThan(10);
    expect(bounds.y).toBeLessThan(20);
    expect(bounds.width).toBeGreaterThan(300);
    expect(bounds.height).toBeGreaterThan(200);
  });

  it("bounds include both nodes and the current viewport", () => {
    const bounds = miniMapWorldBounds(
      [
        makeNode("a", {
          position: { x: -100, y: 0 },
          size: { width: 50, height: 50 },
        }),
        makeNode("b", {
          position: { x: 600, y: 700 },
          size: { width: 80, height: 90 },
        }),
      ],
      { x: 1000, y: -400, width: 300, height: 250 },
    );

    expect(bounds.x).toBeLessThan(-100);
    expect(bounds.y).toBeLessThan(-400);
    expect(bounds.x + bounds.width).toBeGreaterThan(1300);
    expect(bounds.y + bounds.height).toBeGreaterThan(790);
  });

  it("round-trips world rectangles through mini-map coordinates", () => {
    const layout = createMiniMapLayout(
      { x: -100, y: -50, width: 1000, height: 500 },
      250,
      150,
    );
    const source = { x: 150, y: 80, width: 300, height: 120 };
    const mini = worldToMiniMapRect(source, layout);
    const world = miniMapPointToWorld({ x: mini.x, y: mini.y }, layout);

    expect(world.x).toBeCloseTo(source.x);
    expect(world.y).toBeCloseTo(source.y);
    expect(mini.width).toBeCloseTo(source.width * layout.scale);
    expect(mini.height).toBeCloseTo(source.height * layout.scale);
  });
});
