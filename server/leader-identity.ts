/** Leaders execute only as durable work-item runs, including provider resumes. */
export function assertLeaderIdentity(input: {
  role?: string;
  workItemId?: string | null;
  runKey?: string;
}): void {
  if (input.role === "leader" && (!input.workItemId?.trim() || !input.runKey?.trim())) {
    throw new Error("Leader requires a work-item identity; use create_work_item and start_work_item_run.");
  }
}

/** Validate both new launches and resumes before mutating the registry or host. */
export function assertSessionIdentity(
  options: { role?: string; workItemId?: string; sessionKey: string },
  host?: { role: string; workItemId: string | null },
): void {
  assertLeaderIdentity({ role: options.role ?? host?.role,
    workItemId: options.workItemId ?? host?.workItemId, runKey: options.sessionKey });
  if (host?.workItemId && options.workItemId !== undefined && options.workItemId !== host.workItemId) {
    throw new Error("Session work-item identity cannot change.");
  }
}
