import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  blueprintParallaxOffset,
  CanvasBackground,
} from "./CanvasBackground.tsx";

describe("CanvasBackground", () => {
  it("keeps the shared dot grid and Blueprint mesh as separately themeable layers", () => {
    const { container } = render(
      <CanvasBackground transform={{ x: 48, y: -24, scale: 1 }} />,
    );

    expect(container.querySelector(".canvas-dot-grid")).toBeInTheDocument();
    expect(container.querySelector(".blueprint-sphere-grid")).toBeInTheDocument();
    expect(
      container.querySelectorAll(".blueprint-sphere-grid__minor").length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll(".blueprint-sphere-grid__major").length,
    ).toBeGreaterThan(0);
  });

  it("moves the Blueprint mesh only a small, bounded amount during long pans", () => {
    const nearby = blueprintParallaxOffset({ x: 600, y: -450, scale: 1 });
    const distant = blueprintParallaxOffset({ x: 100_000, y: -100_000, scale: 1 });

    expect(nearby.x).toBeGreaterThan(0);
    expect(nearby.y).toBeLessThan(0);
    expect(Math.abs(nearby.x)).toBeLessThan(10);
    expect(Math.abs(nearby.y)).toBeLessThan(10);
    expect(Math.abs(distant.x)).toBeLessThan(19);
    expect(Math.abs(distant.y)).toBeLessThan(15);
  });

  it("renders visibly curved grid paths instead of straight drafting rules", () => {
    const { container } = render(
      <CanvasBackground transform={{ x: 0, y: 0, scale: 1 }} />,
    );
    const path = container.querySelector(
      ".blueprint-sphere-grid__minor",
    )?.getAttribute("d");

    expect(path).toBeTruthy();
    const xCoordinates = path!
      .match(/[ML](-?\d+(?:\.\d+)?) /g)!
      .map((point) => Number.parseFloat(point.slice(1)));
    expect(new Set(xCoordinates).size).toBeGreaterThan(1);
  });
});
