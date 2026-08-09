import { memo } from "react";
import type { CanvasTransform } from "./types.ts";

const GRID_SIZE = 24;
const BLUEPRINT_VIEWBOX_WIDTH = 1200;
const BLUEPRINT_VIEWBOX_HEIGHT = 800;
const BLUEPRINT_GRID_STEP = 60;
const BLUEPRINT_GRID_MAJOR_EVERY = 4;
const BLUEPRINT_WARP_STRENGTH = 0.12;

type GridPath = {
  d: string;
  major: boolean;
};

function warpedPoint(x: number, y: number): [number, number] {
  const halfWidth = BLUEPRINT_VIEWBOX_WIDTH / 2;
  const halfHeight = BLUEPRINT_VIEWBOX_HEIGHT / 2;
  const normalizedX = (x - halfWidth) / halfWidth;
  const normalizedY = (y - halfHeight) / halfHeight;
  const radiusSquared = normalizedX ** 2 + normalizedY ** 2;
  const warp = 1 + BLUEPRINT_WARP_STRENGTH * radiusSquared;

  return [
    halfWidth + normalizedX * halfWidth * warp,
    halfHeight + normalizedY * halfHeight * warp,
  ];
}

function pathThrough(points: Array<[number, number]>): string {
  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
}

function buildBlueprintGridPaths(): GridPath[] {
  const paths: GridPath[] = [];
  const sampleStep = 20;
  const xStart = -BLUEPRINT_GRID_STEP * 2;
  const xEnd = BLUEPRINT_VIEWBOX_WIDTH + BLUEPRINT_GRID_STEP * 2;
  const yStart = -BLUEPRINT_GRID_STEP * 2;
  const yEnd = BLUEPRINT_VIEWBOX_HEIGHT + BLUEPRINT_GRID_STEP * 2;

  for (let x = xStart; x <= xEnd; x += BLUEPRINT_GRID_STEP) {
    const points: Array<[number, number]> = [];
    for (let y = yStart; y <= yEnd; y += sampleStep) {
      points.push(warpedPoint(x, y));
    }
    const gridIndex = Math.round(x / BLUEPRINT_GRID_STEP);
    paths.push({
      d: pathThrough(points),
      major: gridIndex % BLUEPRINT_GRID_MAJOR_EVERY === 0,
    });
  }

  for (let y = yStart; y <= yEnd; y += BLUEPRINT_GRID_STEP) {
    const points: Array<[number, number]> = [];
    for (let x = xStart; x <= xEnd; x += sampleStep) {
      points.push(warpedPoint(x, y));
    }
    const gridIndex = Math.round(y / BLUEPRINT_GRID_STEP);
    paths.push({
      d: pathThrough(points),
      major: gridIndex % BLUEPRINT_GRID_MAJOR_EVERY === 0,
    });
  }

  return paths;
}

const BLUEPRINT_GRID_PATHS = buildBlueprintGridPaths();

/**
 * Keep the warped drafting surface tied loosely to the canvas without letting
 * long pans drag it out of view. The arctangent gives us natural, bounded
 * movement: responsive near the resting point and increasingly subtle farther
 * away.
 */
export function blueprintParallaxOffset(transform: CanvasTransform): {
  x: number;
  y: number;
} {
  return {
    x: Math.atan(transform.x / 1200) * 12,
    y: Math.atan(transform.y / 900) * 9,
  };
}

const DotGrid = memo(function DotGrid({ transform }: { transform: CanvasTransform }) {
  const dotSpacing = GRID_SIZE * transform.scale;
  const offsetX = (transform.x % dotSpacing + dotSpacing) % dotSpacing;
  const offsetY = (transform.y % dotSpacing + dotSpacing) % dotSpacing;

  return (
    <svg
      className="canvas-dot-grid"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <defs>
        <pattern
          id="dot-grid"
          width={dotSpacing}
          height={dotSpacing}
          patternUnits="userSpaceOnUse"
          x={offsetX}
          y={offsetY}
        >
          <circle
            cx={1}
            cy={1}
            r={1}
            fill="var(--dot-grid)"
            opacity={Math.min(1, transform.scale)}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  );
});

const BlueprintSphereGrid = memo(function BlueprintSphereGrid({
  transform,
}: {
  transform: CanvasTransform;
}) {
  const parallax = blueprintParallaxOffset(transform);

  return (
    <svg
      className="blueprint-sphere-grid"
      aria-hidden="true"
      viewBox={`0 0 ${BLUEPRINT_VIEWBOX_WIDTH} ${BLUEPRINT_VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "var(--blueprint-grid-display, none)",
        pointerEvents: "none",
      }}
    >
      <defs>
        <radialGradient id="blueprint-grid-fade" cx="50%" cy="48%" r="72%">
          <stop offset="0%" stopColor="white" stopOpacity="0.94" />
          <stop offset="62%" stopColor="white" stopOpacity="0.7" />
          <stop offset="100%" stopColor="white" stopOpacity="0.16" />
        </radialGradient>
        <mask id="blueprint-grid-vignette">
          <rect
            width={BLUEPRINT_VIEWBOX_WIDTH}
            height={BLUEPRINT_VIEWBOX_HEIGHT}
            fill="url(#blueprint-grid-fade)"
          />
        </mask>
      </defs>
      <g
        mask="url(#blueprint-grid-vignette)"
        transform={`translate(${parallax.x.toFixed(2)} ${parallax.y.toFixed(2)})`}
      >
        {BLUEPRINT_GRID_PATHS.map((path, index) => (
          <path
            key={index}
            className={
              path.major
                ? "blueprint-sphere-grid__major"
                : "blueprint-sphere-grid__minor"
            }
            d={path.d}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
});

export const CanvasBackground = memo(function CanvasBackground({
  transform,
}: {
  transform: CanvasTransform;
}) {
  return (
    <>
      <DotGrid transform={transform} />
      <BlueprintSphereGrid transform={transform} />
    </>
  );
});
