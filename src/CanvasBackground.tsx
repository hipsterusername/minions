import { memo, useId } from "react";
import type { CanvasTransform } from "./types.ts";

const GRID_SIZE = 24;
const BLUEPRINT_VIEWBOX_WIDTH = 1200;
const BLUEPRINT_VIEWBOX_HEIGHT = 800;
const BLUEPRINT_CURVE_STEP = 60;
const BLUEPRINT_CURVE_MAJOR_EVERY = 4;
const BLUEPRINT_CURVE_STRENGTH = 0.1;

type GridPath = {
  d: string;
  major: boolean;
};

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function svgId(prefix: string, reactId: string): string {
  return `${prefix}-${reactId.replaceAll(":", "")}`;
}

function curvedPoint(x: number, y: number): [number, number] {
  const halfWidth = BLUEPRINT_VIEWBOX_WIDTH / 2;
  const halfHeight = BLUEPRINT_VIEWBOX_HEIGHT / 2;
  const normalizedX = (x - halfWidth) / halfWidth;
  const normalizedY = (y - halfHeight) / halfHeight;
  const radiusSquared = normalizedX ** 2 + normalizedY ** 2;
  const curve = 1 + BLUEPRINT_CURVE_STRENGTH * radiusSquared;

  return [
    halfWidth + normalizedX * halfWidth * curve,
    halfHeight + normalizedY * halfHeight * curve,
  ];
}

function pathThrough(points: Array<[number, number]>): string {
  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
}

function buildBlueprintCurvePaths(): GridPath[] {
  const paths: GridPath[] = [];
  const sampleStep = 20;
  const xStart = -BLUEPRINT_CURVE_STEP * 2;
  const xEnd = BLUEPRINT_VIEWBOX_WIDTH + BLUEPRINT_CURVE_STEP * 2;
  const yStart = -BLUEPRINT_CURVE_STEP * 2;
  const yEnd = BLUEPRINT_VIEWBOX_HEIGHT + BLUEPRINT_CURVE_STEP * 2;

  for (let x = xStart; x <= xEnd; x += BLUEPRINT_CURVE_STEP) {
    const points: Array<[number, number]> = [];
    for (let y = yStart; y <= yEnd; y += sampleStep) {
      points.push(curvedPoint(x, y));
    }
    paths.push({
      d: pathThrough(points),
      major:
        Math.round(x / BLUEPRINT_CURVE_STEP) % BLUEPRINT_CURVE_MAJOR_EVERY === 0,
    });
  }

  for (let y = yStart; y <= yEnd; y += BLUEPRINT_CURVE_STEP) {
    const points: Array<[number, number]> = [];
    for (let x = xStart; x <= xEnd; x += sampleStep) {
      points.push(curvedPoint(x, y));
    }
    paths.push({
      d: pathThrough(points),
      major:
        Math.round(y / BLUEPRINT_CURVE_STEP) % BLUEPRINT_CURVE_MAJOR_EVERY === 0,
    });
  }

  return paths;
}

const BLUEPRINT_CURVE_PATHS = buildBlueprintCurvePaths();

export function blueprintParallaxOffset(transform: CanvasTransform): {
  x: number;
  y: number;
} {
  return {
    x: Math.atan(transform.x / 1200) * 14,
    y: Math.atan(transform.y / 900) * 10,
  };
}

const DotGrid = memo(function DotGrid({ transform }: { transform: CanvasTransform }) {
  const patternId = svgId("canvas-dot-grid", useId());
  const dotSpacing = GRID_SIZE * transform.scale;
  const offsetX = positiveModulo(transform.x, dotSpacing);
  const offsetY = positiveModulo(transform.y, dotSpacing);

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
          id={patternId}
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
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
});

const BlueprintCurveGrid = memo(function BlueprintCurveGrid({
  transform,
}: {
  transform: CanvasTransform;
}) {
  const reactId = useId();
  const fadeId = svgId("blueprint-curve-fade", reactId);
  const maskId = svgId("blueprint-curve-mask", reactId);
  const parallax = blueprintParallaxOffset(transform);

  return (
    <svg
      className="blueprint-curve-grid"
      aria-hidden="true"
      viewBox={`0 0 ${BLUEPRINT_VIEWBOX_WIDTH} ${BLUEPRINT_VIEWBOX_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
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
        <radialGradient id={fadeId} cx="50%" cy="48%" r="72%">
          <stop offset="0%" stopColor="white" stopOpacity="0.9" />
          <stop offset="62%" stopColor="white" stopOpacity="0.62" />
          <stop offset="100%" stopColor="white" stopOpacity="0.08" />
        </radialGradient>
        <mask id={maskId}>
          <rect
            x={-BLUEPRINT_CURVE_STEP * 3}
            y={-BLUEPRINT_CURVE_STEP * 3}
            width={BLUEPRINT_VIEWBOX_WIDTH + BLUEPRINT_CURVE_STEP * 6}
            height={BLUEPRINT_VIEWBOX_HEIGHT + BLUEPRINT_CURVE_STEP * 6}
            fill={`url(#${fadeId})`}
          />
        </mask>
      </defs>
      <g
        mask={`url(#${maskId})`}
        transform={`translate(${parallax.x.toFixed(2)} ${parallax.y.toFixed(2)})`}
      >
        {BLUEPRINT_CURVE_PATHS.map((path, index) => (
          <path
            key={index}
            className={
              path.major
                ? "blueprint-curve-grid__major"
                : "blueprint-curve-grid__minor"
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
      <BlueprintCurveGrid transform={transform} />
    </>
  );
});
