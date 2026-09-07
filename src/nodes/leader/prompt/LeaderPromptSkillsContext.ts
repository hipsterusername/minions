import { createContext } from "react";

/** Shared by inline, overlay, fullscreen, and launch composers. */
export const LeaderPromptSkillsContext = createContext<
  ((skillId: string) => void) | undefined
>(undefined);
