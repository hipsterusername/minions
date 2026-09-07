import { useEffect, useState } from "react";
import { getAuthToken } from "./api.ts";
import { MarkdownPreview } from "./components/MarkdownPreview.tsx";
import "./file-link-view.css";

export default function FileLinkView() {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project") ?? "";
  const path = params.get("path") ?? "";
  const line = Number(params.get("line")) || 1;
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
  const pdf = /\.pdf$/i.test(path);
  const markdown = /\.mdx?$/i.test(path) && !params.has("line");

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    document.title = path.split("/").pop() || "File viewer";
    async function load() {
      try {
        if (!project || !path) throw new Error("Missing project or file path.");
        const token = await getAuthToken();
        const response = await fetch(`/api/projects/${encodeURIComponent(project)}/${image || pdf ? "blob" : "file"}?path=${encodeURIComponent(path)}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Unable to open file (HTTP ${response.status}).`);
        }
        if (image || pdf) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(pdf ? new Blob([blob], { type: "application/pdf" }) : blob);
          setBlobUrl(objectUrl);
        } else {
          const body = await response.json() as { content: string; truncated: boolean };
          if (controller.signal.aborted) return;
          setContent(body.content);
          setTruncated(body.truncated);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Unable to open file.");
      }
    }
    void load();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [project, path, image, pdf]);

  useEffect(() => {
    if (content !== null) document.getElementById(`L${line}`)?.scrollIntoView?.({ block: "center" });
  }, [content, line]);

  return <main className="file-link-view">
    <h1 style={{ fontSize: 18, overflowWrap: "anywhere" }}>{path || "File viewer"}</h1>
    {error ? <p role="alert">{error}</p> : content === null && !blobUrl ? <p role="status">Loading file…</p> : null}
    {truncated && <p role="status">This preview is limited to the first 512 KB.</p>}
    {blobUrl && (image ? <img src={blobUrl} alt={path} style={{ maxWidth: "100%" }} /> : <iframe title={path} src={`${blobUrl}#page=1`} style={{ width: "100%", height: "85vh", border: 0 }} />)}
    {content !== null && (markdown ? <MarkdownPreview content={content} /> : <pre style={{ overflowX: "auto", lineHeight: 1.6 }}>
      {content.split("\n").map((text, index) => <div key={index} id={`L${index + 1}`} style={{ background: index + 1 === line && params.has("line") ? "var(--state-hover)" : undefined }}>
        <span aria-hidden="true" style={{ display: "inline-block", minWidth: "4ch", marginRight: 20, opacity: 0.5, userSelect: "none", textAlign: "right" }}>{index + 1}</span>{text || " "}
      </div>)}
    </pre>)}
  </main>;
}
