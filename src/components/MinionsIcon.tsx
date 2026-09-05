import type { CSSProperties, ReactNode } from "react";

// Drawn on the same 16px grid as the canvas dock: rounded 1.4px strokes,
// open silhouettes and currentColor keep small icons legible in every skin.
const artwork = {
  skill: <><path d="m8 1.5 5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7Z" /><path d="m8.7 4-3 4.5h4.6l-3 3.5" /></>,
  live: <path d="m9 1.5-6 7h4L6.5 14.5l6.5-8H9Z" />,
  worktree: <><path d="M4 5v6m8-6v1a2 2 0 0 1-2 2H6a2 2 0 0 0-2 2" /><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><rect x="10" y="1.5" width="4" height="4" rx="1" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V4.5a3 3 0 0 1 6 0V7M8 10v1.5" /></>,
  attachment: <path d="m6 9.5 4.7-4.7a1.4 1.4 0 0 1 2 2L6.5 13a3 3 0 0 1-4.2-4.2l6.4-6.4a2.4 2.4 0 0 1 3.4 0" />,
  appearance: <><path d="M8 2a6 6 0 1 0 0 12h1a1.5 1.5 0 0 0 1-2.6c-.7-.7-.2-1.9.8-1.9H12c2.5 0 2.5-3 1-5A6 6 0 0 0 8 2Z" /><path d="M5 5.5h.01M8 4.5h.01M11 6h.01M4.5 8.5h.01" strokeWidth="2" /></>,
  variables: <><path d="M5 2.5H3.5v4L2 8l1.5 1.5v4H5m6-11h1.5v4L14 8l-1.5 1.5v4H11" /><circle cx="8" cy="8" r="1.2" /></>,
  subskills: <><rect x="2" y="2" width="4" height="4" rx="1" /><rect x="10" y="4" width="4" height="4" rx="1" /><rect x="10" y="10" width="4" height="4" rx="1" /><path d="M6 4h2v8h2M8 6h2" /></>,
  wait: <><path d="M4 2h8M4 14h8M5 2v3l3 3-3 3v3m6-12v3L8 8l3 3v3" /><path d="M6.5 12h3" /></>,
  retry: <><path d="M12.7 5.2A5.5 5.5 0 1 0 13.5 9M13 2v3.5H9.5" /><path d="M8 5v3l-2 1" /></>,
  warning: <><path d="m6.8 2.8-5.2 9A1.2 1.2 0 0 0 2.7 13.5h10.6a1.2 1.2 0 0 0 1.1-1.7l-5.2-9a1.4 1.4 0 0 0-2.4 0Z" /><path d="M8 6v3" /><circle cx="8" cy="11.3" r=".7" fill="currentColor" stroke="none" /></>,
  pause: <><rect x="4" y="3" width="2.5" height="10" rx=".7" /><rect x="9.5" y="3" width="2.5" height="10" rx=".7" /></>,
  check: <path d="m3 8 3.2 3.2L13 4.5" />,
  close: <path d="m4 4 8 8m0-8-8 8" />,
  planned: <circle cx="8" cy="8" r="5" />,
  active: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></>,
  minus: <path d="M3.5 8h9" />,
  waived: <><path d="M2.5 8a5.5 5.5 0 0 0 9.4 3.9M13.5 8a5.5 5.5 0 0 0-9.4-3.9M2.5 4v4H6m7.5 4V8H10" /><path d="M6 8h4" /></>,
  compaction: <><path d="m2 2 3 3m-3 9 3-3m9-9-3 3m3 9-3-3" /><rect x="5" y="5" width="6" height="6" rx="1" /></>,
  folder: <><path d="M2 5V3.5A1 1 0 0 1 3 2.5h3L8 5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /><path d="M2 6h12" /></>,
  "folder-open": <><path d="M2 11.5v-8a1 1 0 0 1 1-1h3L8 5h4a1 1 0 0 1 1 1v1" /><path d="M4 7h10.5L12 13.5H1.5Z" /></>,
  file: <><path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6Z" /><path d="M9 2v4h4M5.5 9h5m-5 2.5h3" /></>,
  settings: <><path d="M3.5 2v2m0 3v7M8 2v7m0 3v2m4.5-12v2m0 3v7" /><rect x="1.8" y="4" width="3.4" height="3" rx="1" /><rect x="6.3" y="9" width="3.4" height="3" rx="1" /><rect x="10.8" y="4" width="3.4" height="3" rx="1" /></>,
  play: <path d="m5 2.5 8 5.5-8 5.5Z" />,
  code: <><path d="m5 4-3.5 4L5 12m6-8 3.5 4-3.5 4m-2-9-2 10" /></>,
  testing: <><path d="M5.5 2h5M6 2v4l-3.5 6a1 1 0 0 0 1 1.5h9a1 1 0 0 0 1-1.5L10 6V2M4.5 9h7" /><path d="m6.5 11 1 1 2-2" /></>,
  devops: <><rect x="2" y="2.5" width="12" height="4" rx="1" /><rect x="2" y="9.5" width="12" height="4" rx="1" /><path d="M8 6.5v3M5 4.5h.01M5 11.5h.01M8 4.5h3m-3 7h3" /></>,
  analysis: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M5 8V6.5M7 8V5m2 3V6" /></>,
  terminal: <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="m4 6 2 2-2 2m4 0h3" /></>,
  bug: <><rect x="5" y="5" width="6" height="8" rx="3" /><path d="m6 5-1-2m5 2 1-2M2 6l3 1m6 0 3-1M2 10h3m6 0h3M3 14l2-2m6 0 2 2M8 6v6" /></>,
  branch: <><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" /><path d="M4 4.5v7M12 4.5v1a4 4 0 0 1-4 4H4" /></>,
  merge: <><circle cx="4" cy="3" r="1.5" /><circle cx="12" cy="3" r="1.5" /><circle cx="8" cy="13" r="1.5" /><path d="M4 4.5v1A3 3 0 0 0 7 8h1m4-3.5v1A3 3 0 0 1 9 8H8v3.5" /></>,
  commit: <><circle cx="8" cy="8" r="3" /><path d="M1.5 8H5m6 0h3.5" /></>,
  brackets: <path d="M5 2.5H2.5v11H5m6-11h2.5v11H11M7 5l2 6" />,
  database: <><ellipse cx="8" cy="4" rx="5.5" ry="2" /><path d="M2.5 4v8c0 2.7 11 2.7 11 0V4M2.5 8c0 2.7 11 2.7 11 0" /></>,
  api: <><rect x="5" y="5" width="6" height="6" rx="1" /><path d="M8 1.5V5m0 6v3.5M1.5 8H5m6 0h3.5M3 3l2 2m6 6 2 2m0-10-2 2m-6 6-2 2" /></>,
  package: <><path d="m8 1.5 6 3.2v6.6l-6 3.2-6-3.2V4.7ZM2 4.7 8 8l6-3.3M8 8v6.5M5 3l6 3.3v3" /></>,
  puzzle: <path d="M2 2h4v2a1.5 1.5 0 1 0 3 0V2h5v4h-2a1.5 1.5 0 0 0 0 3h2v5H9v-2a1.5 1.5 0 0 0-3 0v2H2Z" />,
  cpu: <><rect x="4" y="4" width="8" height="8" rx="1" /><rect x="6" y="6" width="4" height="4" rx=".5" /><path d="M6 1v3m4-3v3M6 12v3m4-3v3M1 6h3m-3 4h3m8-4h3m-3 4h3" /></>,
  regex: <><path d="M3 11h.01M10 3v8M6.5 5l7 4m0-4-7 4" /><circle cx="3" cy="11" r="1" /></>,
  shield: <><path d="m8 1.5 5.5 2v4c0 3-2 5.5-5.5 7-3.5-1.5-5.5-4-5.5-7v-4Z" /><path d="m5.5 8 1.5 1.5 3.5-4" /></>,
  key: <><circle cx="5" cy="5" r="3" /><path d="m7.2 7.2 6.3 6.3M11 11l2-2m-4 0 2-2" /></>,
  scan: <><path d="M5 2H2v3m9-3h3v3M2 11v3h3m9-3v3h-3M2 8h12" /><path d="M5 5h6v6H5Z" /></>,
  fingerprint: <><path d="M2 8a6 6 0 0 1 12 0v2M4 11V8a4 4 0 0 1 8 0v3l-1 3M6 14V8a2 2 0 0 1 4 0v3m-2-3v6M2 10v2" /></>,
  eye: <><path d="M1.5 8S4 3 8 3s6.5 5 6.5 5S12 13 8 13 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>,
  target: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r=".6" fill="currentColor" /></>,
  gauge: <><path d="M3 13a6 6 0 1 1 10 0ZM8 4v1M4 7l1 1m7-1-1 1m-3 2 2-3" /><circle cx="8" cy="10" r="1" /></>,
  checklist: <><path d="m2 3 1 1 2-2m-3 6 1 1 2-2m-3 6 1 1 2-2M8 3h6M8 8h6m-6 5h6" /></>,
  microscope: <><path d="m7 2 3 1-2 6-3-1ZM9 7a4 4 0 0 1 1 7H3m3-4-2-1m2 5v-2" /><path d="m8 1 3 1" /></>,
  cloud: <path d="M4 12a3 3 0 0 1-.5-6 4.5 4.5 0 0 1 8.8-.3A3.2 3.2 0 0 1 12 12Z" />,
  rocket: <><path d="M6 10C6 5 9 2 14 2c0 5-3 8-8 8Zm0 0L4 8m2 2 2 2M5 6H3L1.5 10H5m5 1v2l-4 1.5V11M4 12l-2 2" /><circle cx="10.5" cy="5.5" r="1" /></>,
  globe: <><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.5" ry="6" /><path d="M2 8h12" /></>,
  network: <><rect x="6" y="1.5" width="4" height="4" rx="1" /><rect x="1.5" y="10.5" width="4" height="4" rx="1" /><rect x="10.5" y="10.5" width="4" height="4" rx="1" /><path d="M8 5.5v2H3.5v3m4.5-3h4.5v3" /></>,
  container: <><rect x="1.5" y="4" width="13" height="9" rx="1" /><path d="M5 4V2h6v2M5 7v3m3-3v3m3-3v3" /></>,
  workflow: <><rect x="1.5" y="2" width="4" height="4" rx="1" /><rect x="10.5" y="10" width="4" height="4" rx="1" /><path d="M5.5 4H11a2 2 0 0 1 0 4H5a2 2 0 0 0 0 4h5.5m-2-2 2 2-2 2" /></>,
  satellite: <><path d="m6 3 7 7-3 3-7-7Zm-2 4-3 3 2 2 3-3m3-5 3-3 2 2-3 3M3 14a2 2 0 0 0-2-2m0-3a5 5 0 0 1 5 5" /></>,
  plug: <><path d="M5 1.5V5m6-3.5V5M3 5h10M4 5v3a4 4 0 0 0 8 0V5M8 12v2.5" /></>,
  layers: <path d="m8 1.5 6.5 3.8L8 9 1.5 5.3Zm-6.5 7L8 12l6.5-3.5m-13 3L8 15l6.5-3.5" />,
  pen: <><path d="m11 2 3 3-8 8-4 1 1-4Zm-8 8 3 3m3-9 3 3" /></>,
  book: <><path d="M8 4C6 2 3 2 1.5 3v10C4 12 6 12 8 14c2-2 4-2 6.5-1V3C13 2 10 2 8 4Zm0 0v10" /></>,
  notebook: <><rect x="3" y="1.5" width="11" height="13" rx="1" /><path d="M1.5 5h3m-3 3h3m-3 3h3M7 5h4M7 8h4m-4 3h2" /></>,
  heading: <path d="M3 3v10M13 3v10M3 8h10M1.5 3h3m-3 10h3m7-10h3m-3 10h3" />,
  quote: <><path d="M2 8h4v5H2V7a4 4 0 0 1 4-4m4 5h4v5h-4V7a4 4 0 0 1 4-4" /></>,
  list: <><path d="M6 3h8M6 8h8m-8 5h8" /><circle cx="2" cy="3" r=".6" /><circle cx="2" cy="8" r=".6" /><circle cx="2" cy="13" r=".6" /></>,
  bookmark: <path d="M4 2h8v12l-4-3-4 3Z" />,
  archive: <><rect x="1.5" y="2" width="13" height="3" rx=".5" /><path d="M3 5v9h10V5M6 8h4" /></>,
  translate: <><path d="M1 4h8M5 2v2m2 0c0 4-3 6-6 7m2-5 5 5m1 3 3-8 3 8m-5-2h4" /></>,
  link: <><path d="m6 5 2-2a3.5 3.5 0 0 1 5 5l-2 2M5 6 3 8a3.5 3.5 0 0 0 5 5l2-2M5.5 10.5l5-5" /></>,
  brush: <><path d="m7 8 5-6a1.4 1.4 0 0 1 2 2l-6 5Zm0 0C1 7 5 12 1.5 14 6 15 9 12 8 9" /></>,
  layout: <><rect x="1.5" y="2" width="13" height="12" rx="1" /><path d="M1.5 6h13M6 6v8" /></>,
  grid: <><rect x="2" y="2" width="5" height="5" rx=".7" /><rect x="9" y="2" width="5" height="5" rx=".7" /><rect x="2" y="9" width="5" height="5" rx=".7" /><rect x="9" y="9" width="5" height="5" rx=".7" /></>,
  vector: <><rect x="6.5" y="2.5" width="3" height="3" rx=".5" /><path d="M2 4h4.5m3 0H14M7 5.5C3 6 2 9 2 12m7-6.5c4 .5 5 3.5 5 6.5" /><rect x="1" y="12" width="2" height="2" /><rect x="13" y="12" width="2" height="2" /></>,
  image: <><rect x="1.5" y="2" width="13" height="12" rx="1" /><circle cx="5" cy="5.5" r="1" /><path d="m2 12 4-4 3 3 2-2 3 3" /></>,
  camera: <><path d="M2 5h3l1-2h4l1 2h3v9H2Z" /><circle cx="8" cy="9" r="2.5" /></>,
  film: <><rect x="1.5" y="2" width="13" height="12" rx="1" /><path d="M5 2v12m6-12v12M2 6h3m-3 4h3m6-4h3m-3 4h3" /></>,
  music: <><path d="M6 11V3l8-1v8M6 6l8-1" /><ellipse cx="4" cy="12" rx="2" ry="1.5" /><ellipse cx="12" cy="11" rx="2" ry="1.5" /></>,
  headphones: <><path d="M2 9V8a6 6 0 0 1 12 0v1" /><rect x="1.5" y="8" width="3" height="6" rx="1" /><rect x="11.5" y="8" width="3" height="6" rx="1" /></>,
  phone: <><rect x="4" y="1.5" width="8" height="13" rx="1.5" /><path d="M7 4h2m-1 8h.01" /></>,
  monitor: <><rect x="1.5" y="2" width="13" height="9" rx="1" /><path d="M8 11v3m-3 0h6" /></>,
  ruler: <><path d="m10 1 5 5-9 9-5-5Zm-2 2 2 2M6 5l1 1M4 7l2 2" /></>,
  chart: <path d="M2 2v12h12M5 11V8m4 3V5m4 6V2" />,
  trend: <path d="M2 12 6 8l3 2 5-7m-4 0h4v4" />,
  pie: <><path d="M7 2a6 6 0 1 0 7 7H7ZM10 1.5v5h5a5 5 0 0 0-5-5Z" /></>,
  table: <><rect x="1.5" y="2" width="13" height="12" rx="1" /><path d="M1.5 6h13m-13 4h13M6 6v8m4-8v8" /></>,
  filter: <path d="M1.5 2.5h13L10 8v5l-4 1V8Z" />,
  compass: <><circle cx="8" cy="8" r="6" /><path d="m10.5 5.5-1 4-4 1 1-4Z" /></>,
  map: <path d="m1.5 3 4-1 5 2 4-1v10l-4 1-5-2-4 1Zm4-1v10m5-8v10" />,
  flask: <><path d="M5 2h6M6 2v5l-4 6a.7.7 0 0 0 .6 1h10.8a.7.7 0 0 0 .6-1l-4-6V2M4 10h8" /></>,
  atom: <><ellipse cx="8" cy="8" rx="7" ry="2.5" /><ellipse cx="8" cy="8" rx="7" ry="2.5" transform="rotate(60 8 8)" /><ellipse cx="8" cy="8" rx="7" ry="2.5" transform="rotate(120 8 8)" /></>,
  brain: <><path d="M8 3C5 0 2 3 3 5 0 6 1 10 3 10c-1 4 3 5 5 3 2 2 6 1 5-3 2 0 3-4 0-5 1-2-2-5-5-2Zm0 0v10M3 5l2 1m8-1-2 1M3 10l2-1m8 1-2-1" /></>,
  lightbulb: <><path d="M5 11C5 8 3 8 3 6a5 5 0 0 1 10 0c0 2-2 2-2 5ZM6 14h4m-2-3V7M6 6l2 1 2-1" /></>,
  bot: <><rect x="2" y="5" width="12" height="9" rx="2" /><path d="M8 2v3M1 8v3m14-3v3M5 8v1m6-1v1m-5 3h4" /><circle cx="8" cy="2" r="1" /></>,
  sparkles: <path d="m6 3 1.5 4.5L12 9l-4.5 1.5L6 15l-1.5-4.5L0 9l4.5-1.5ZM12 1l.8 2.2L15 4l-2.2.8L12 7l-.8-2.2L9 4l2.2-.8Z" />,
  wand: <><path d="m2 12 9-9 3 3-9 9ZM9 5l3 3M3 2v3M1.5 3.5h3M12 11v3m-1.5-1.5h3" /></>,
  message: <><path d="M2 2h12v9H7l-5 3ZM5 5h6M5 8h4" /></>,
  people: <><circle cx="6" cy="5" r="2.5" /><path d="M1.5 14v-2a4.5 4.5 0 0 1 9 0v2M11 2.5a2.5 2.5 0 0 1 0 5M12 10a3 3 0 0 1 2.5 3v1" /></>,
  flag: <path d="M3 14V2c3-2 7 2 10 0v7c-3 2-7-2-10 0" />,
  calendar: <><rect x="2" y="3" width="12" height="11" rx="1" /><path d="M5 1.5v3m6-3v3M2 7h12m-9 3h2m2 0h2m-6 2h2" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4v4l3 2" /></>,
  heart: <path d="M8 14 2.5 8.5C-1 5 4 0 8 4c4-4 9 1 5.5 4.5Z" />,
  leaf: <><path d="M13 2C5 1 1 5 3 10c2 5 11 3 10-8ZM2 14l8-8" /></>,
  diamond: <path d="M4 2h8l3 4-7 8L1 6Zm-3 4h14M4 2l4 12 4-12" />,
  trophy: <><path d="M4 2h8v4a4 4 0 0 1-8 0ZM4 4H1v2a3 3 0 0 0 4 3m7-5h3v2a3 3 0 0 1-4 3M8 10v4m-3 0h6" /></>,
  cube: <path d="m8 1.5 6 3.3v6.4l-6 3.3-6-3.3V4.8ZM2 4.8 8 8l6-3.2M8 8v6.5" />,
  orbit: <><circle cx="8" cy="8" r="2" /><ellipse cx="8" cy="8" rx="7" ry="3.5" transform="rotate(-40 8 8)" /><circle cx="12" cy="3" r="1.5" fill="var(--bg-secondary)" /></>,
} satisfies Record<string, ReactNode>;

export type MinionsIconName = keyof typeof artwork;

export function isMinionsIconName(name: string): name is MinionsIconName {
  return Object.hasOwn(artwork, name);
}

export function MinionsIcon({
  name,
  size = 16,
  label,
  style,
}: {
  name: MinionsIconName;
  size?: number;
  /** Omit for decorative icons alongside text or in an already labelled control. */
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      data-minions-icon={name}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0, ...style }}
    >
      {artwork[name]}
    </svg>
  );
}
