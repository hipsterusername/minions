import { describe, expect, it } from "vitest";
import { chatRoleStyle } from "./chat-bubble-style.ts";

describe("chatRoleStyle", () => {
  it("places user flush as a symmetric tinted block", () => {
    const user = chatRoleStyle("user");
    // User is symmetric (paddingInline shorthand) because it's a
    // tinted block; assistant/tool/thinking use paddingInlineStart
    // because their indentation is asymmetric (left only).
    expect(user.paddingInline).toBe(10);
    expect(user.paddingInlineStart).toBeUndefined();
  });

  it("indent cascades assistant < tool < thinking (the reply ladder)", () => {
    const order = ["assistant", "tool", "thinking"] as const;
    const indents = order.map(
      (role) => chatRoleStyle(role).paddingInlineStart as number,
    );
    expect(indents).toEqual([26, 42, 58]);
    expect(new Set(indents).size).toBe(indents.length);
  });

  it("renders tool body in monospace and thinking in italic", () => {
    expect(chatRoleStyle("tool").fontFamily).toBe("var(--font-mono)");
    expect(chatRoleStyle("thinking").fontStyle).toBe("italic");
    expect(chatRoleStyle("assistant").fontFamily).toBe("var(--font-sans)");
  });

  it("encodes role color in the body, not in chrome", () => {
    expect(chatRoleStyle("user").color).toBe("var(--accent)");
    expect(chatRoleStyle("assistant").color).toBe("var(--text-primary)");
    expect(chatRoleStyle("result").color).toBe("var(--status-success)");
    expect(chatRoleStyle("tool").color).toBe("var(--text-muted)");
    expect(chatRoleStyle("thinking").color).toBe("var(--text-dim)");
  });

  it("never returns a border — bubble chrome stays out", () => {
    const roles = [
      "user",
      "assistant",
      "tool",
      "system",
      "thinking",
      "result",
    ] as const;
    for (const role of roles) {
      const style = chatRoleStyle(role);
      expect(style.border).toBeUndefined();
      expect(style.borderLeft).toBeUndefined();
    }
  });

  it("only the user row carries a small geometric corner radius", () => {
    expect(chatRoleStyle("user").borderRadius).toBe(5);
    for (const role of ["assistant", "tool", "system", "thinking", "result"] as const) {
      expect(chatRoleStyle(role).borderRadius).toBeUndefined();
    }
  });

  it("only the user row carries an on-theme background tint", () => {
    const roles = [
      "assistant",
      "tool",
      "system",
      "thinking",
      "result",
    ] as const;
    for (const role of roles) {
      expect(chatRoleStyle(role).background).toBeUndefined();
      expect(chatRoleStyle(role).backgroundColor).toBeUndefined();
    }
    const userBg = chatRoleStyle("user").background;
    expect(userBg).toBeDefined();
    expect(String(userBg)).toContain("var(--accent)");
    expect(String(userBg)).toContain("color-mix");
  });

  it("flips result body color to error on isError", () => {
    expect(chatRoleStyle("result").color).toBe("var(--status-success)");
    expect(chatRoleStyle("result", { isError: true }).color).toBe(
      "var(--status-error)",
    );
  });

  it("compact density shaves font size for chat-log surfaces", () => {
    expect((chatRoleStyle("assistant").fontSize as number) >
      (chatRoleStyle("assistant", { density: "compact" }).fontSize as number),
    ).toBe(true);
  });

  it("places user, assistant, and result in a clear weight ladder", () => {
    expect(chatRoleStyle("user").fontWeight).toBe(500);
    expect(chatRoleStyle("assistant").fontWeight).toBe(400);
    expect(chatRoleStyle("result").fontWeight).toBe(500);
  });
});
