import { isArchivePlaceholderText } from "../shared/history.ts";
import type { DisplayMessage } from "./sdk-messages.ts";

/** Remove generated archive records, while preserving users discussing them. */
export function isArchiveDisplayMessage(message: Pick<DisplayMessage, "role" | "content">): boolean {
  return message.role !== "user" && isArchivePlaceholderText(message.content);
}
