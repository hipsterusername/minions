import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  blueprintParallaxOffset,
  CanvasBackground,
} from "./CanvasBackground.tsx";

describe("CanvasBackground", () => {
  it("keeps the shared dots and curved Blueprint layer separately themeable", () => {
    const { container } = render(
      <CanvasBackground transform={{ x: 48, y: -24, scale: 1 }} />,
    );

    expect(container.querySelector(".canvas-dot-grid")).toBeInTheDocument();
    expect(container.querySelector(".blueprint-curve-grid")).toBeInTheDocument();
    expect(container.querySelector(".blueprint-grid")).not.toBeInTheDocument();
  });

  it("renders a curved mesh without stretching its viewBox to the viewport", () => {
    const { container } = render(
      <CanvasBackground transform={{ x: 0, y: 0, scale: 1 }} />,
    );
    const curveGrid = container.querySelector(".blueprint-curve-grid");
    const path = container
      .querySelector(".blueprint-curve-grid__minor")
      ?.getAttribute("d");

    expect(curveGrid).toHaveAttribute("preserveAspectRatio", "xMidYMid slice");
    expect(path).toBeTruthy();
    const xCoordinates = path!
      .match(/[ML](-?\d+(?:\.\d+)?) /g)!
      .map((point) => Number.parseFloat(point.slice(1)));
    expect(new Set(xCoordinates).size).toBeGreaterThan(1);
  });

  it("moves the curved depth layer by a small bounded parallax amount", () => {
    const nearby = blueprintParallaxOffset({ x: 600, y: -450, scale: 1 });
    const distant = blueprintParallaxOffset({ x: 100_000, y: -100_000, scale: 1 });

    expect(nearby.x).toBeGreaterThan(0);
    expect(nearby.y).toBeLessThan(0);
    expect(Math.abs(distant.x)).toBeLessThan(22);
    expect(Math.abs(distant.y)).toBeLessThan(16);
  });

  it("uses unique SVG resource ids for multiple canvas instances", () => {
    const { container } = render(
      <>
        <CanvasBackground transform={{ x: 0, y: 0, scale: 1 }} />
        <CanvasBackground transform={{ x: 100, y: 50, scale: 1 }} />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]"), (node) => node.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
