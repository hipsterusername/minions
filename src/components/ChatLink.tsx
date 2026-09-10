import { createContext, useContext, useMemo, type ReactNode } from "react";

export const ChatLinkContext = createContext<{ project: string; cwd?: string | undefined } | null>(null);

/** Keep file access scoped to the workspace while resolving relative links in the session CWD. */
export function ChatLinkScope({ project, cwd, children }: { project?: string | null | undefined; cwd?: string | undefined; children: ReactNode }) {
  const parent = useContext(ChatLinkContext);
  const value = useMemo(() => {
    const reference = project || parent?.project || (cwd ? btoa(Array.from(new TextEncoder().encode(cwd), (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null);
    return reference ? { project: reference, cwd: cwd ?? parent?.cwd } : null;
  }, [project, cwd, parent]);
  return <ChatLinkContext.Provider value={value}>{children}</ChatLinkContext.Provider>;
}

export function fileViewHref(destination: string, project: string, cwd?: string): string | null {
  let path = destination;
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname + url.hash;
    }
    path = decodeURIComponent(path);
  } catch { return null; }
  const location = path.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/);
  const line = location?.[1] ?? location?.[2];
  if (location) path = path.slice(0, location.index);
  if (!path || /[\u0000-\u001f]/.test(path)) return null;
  if (!path.startsWith("/") && cwd) path = `${cwd.replace(/\/$/, "")}/${path}`;
  const params = new URLSearchParams({ project, path });
  if (line) params.set("line", line);
  return `/file-view?${params}`;
}

export function ChatLink({ destination, children }: { destination: string; children: ReactNode }) {
  const context = useContext(ChatLinkContext);
  const target = destination.trim();
  let href: string | null = null;
  if (/^\/api\/history\/[a-zA-Z0-9_%.-]+(?:\/events\/[1-9]\d*|\?before=[1-9]\d*)?$/.test(target)) {
    href = target;
  } else if (/^(https?:\/\/|mailto:)/i.test(target)) {
    href = target;
  } else if (context && !target.startsWith("//") && !target.startsWith("#")
    && (!/^[a-z][a-z\d+.-]*:/i.test(target) || /^file:/i.test(target) || /^[^:/]+\.[^:/]+:\d+(?::\d+)?$/.test(target))) {
    href = fileViewHref(target, context.project, context.cwd);
  }
  if (!href) return <span title={target}>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer"
    style={{ color: "var(--accent)", textDecoration: "underline", overflowWrap: "anywhere" }}
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}>{children}</a>;
}
