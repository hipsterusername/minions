import { existsSync, openSync, closeSync, fstatSync, ftruncateSync, renameSync, rmSync, writeSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The launcher is the only log descriptor owner. Synchronous writes introduce
// backpressure through bounded OS pipes, with no application writer queue.
export function boundedLog(path, segmentBytes = 20 * 1024 * 1024, segments = 5) {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1 || !Number.isSafeInteger(segments) || segments < 1) throw new Error("Invalid log bounds");
  // Remove only this writer's numbered archives when a lower bound is selected.
  const prefix = `${basename(path)}.`;
  for (const name of readdirSync(dirname(path))) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    if (/^[0-9]+$/.test(suffix) && Number(suffix) >= segments) rmSync(join(dirname(path), name));
  }
  // Preserve recent crash evidence when adopting a legacy oversized log.
  function retainTail(filename) {
    if (!existsSync(filename)) return;
    const file = openSync(filename, "r+");
    try {
      const originalSize = fstatSync(file).size;
      if (originalSize <= segmentBytes) return;
      const chunk = Buffer.allocUnsafe(Math.min(segmentBytes, 64 * 1024));
      for (let offset = 0; offset < segmentBytes;) {
        const read = readSync(file, chunk, 0, Math.min(chunk.length, segmentBytes - offset), originalSize - segmentBytes + offset);
        if (!read) throw new Error("Log tail read made no progress");
        for (let written = 0; written < read;) {
          const n = writeSync(file, chunk, written, read - written, offset + written);
          if (!n) throw new Error("Log tail write made no progress");
          written += n;
        }
        offset += read;
      }
      ftruncateSync(file, segmentBytes);
    } finally { closeSync(file); }
  }
  retainTail(path);
  let fd = openSync(path, "a", 0o600);
  let size;
  try {
    size = fstatSync(fd).size;
    // Bound legacy segments too, using only a fixed-size copying buffer.
    for (let i = 1; i < segments; i++) {
      if (!existsSync(`${path}.${i}`)) continue;
      retainTail(`${path}.${i}`);
    }
  } catch (error) { closeSync(fd); throw error; }
  return {
    write(chunk) {
      if (fd === undefined) throw new Error("Log writer is closed");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length;) {
        if (size === segmentBytes) {
          closeSync(fd); fd = undefined;
          rmSync(`${path}.${segments - 1}`, { force: true });
          for (let i = segments - 2; i >= 1; i--) {
            if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
          }
          if (segments > 1) renameSync(path, `${path}.1`);
          else rmSync(path, { force: true });
          fd = openSync(path, "w", 0o600); size = 0;
        }
        const written = writeSync(fd, bytes, offset, Math.min(segmentBytes - size, bytes.length - offset));
        if (!written) throw new Error("Log write made no progress");
        size += written; offset += written;
      }
    },
    close() { if (fd !== undefined) { closeSync(fd); fd = undefined; } },
  };
}
