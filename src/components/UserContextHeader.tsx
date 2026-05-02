/**
 * UserContextHeader — small all-caps "Context" label that sits at the
 * top of every user-message block. It frames the user's input as
 * context the agent is responding to, rather than a chat turn, which
 * fits the canvas mental model where messages are persistent context
 * blocks rather than ephemeral conversation lines.
 *
 * Styled to live inside the user-row's accent-tinted block: small
 * type, looser letter-spacing, weight 600, dimmed accent color so it
 * reads as a section header without competing with the body text.
 */
export function UserContextHeader() {
  return (
    <div
      style={{
        fontSize: 9,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--accent)",
        opacity: 0.7,
        marginBottom: 2,
        userSelect: "none",
      }}
    >
      Context
    </div>
  );
}
