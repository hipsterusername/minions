import type { Request, Response } from "express";
const NAME = "minions_history";
/** Read-only archive navigation needs a scoped HttpOnly credential for ordinary links. */
export function setHistoryCookie(req: Request, res: Response, token: string): void {
  res.cookie(NAME, token, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api/history" });
}
export function historyCookieToken(req: Request): string | null {
  if (req.method !== "GET" || !req.originalUrl.startsWith("/api/history/")) return null;
  const value = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${NAME}=`));
  return value?.slice(NAME.length + 1) ?? null;
}
