/**
 * WebSocket server configuration constants.
 *
 * Kept independent so the values can be tested and reasoned about without
 * booting the whole server.
 */

/**
 * Maximum WebSocket frame size in bytes.
 *
 * The client sends image attachments as base64-encoded `data:` URLs
 * inside a JSON envelope. Base64 inflates payloads by ~33%, so a 24MB
 * source image arrives as ~32MB over the wire. The prior 1MB ceiling
 * rejected ordinary screenshots with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`
 * (close code 1009); 32MB gives ample headroom for the image + prompt
 * + annotations envelope while still capping abusive payloads well
 * below the `ws` default of 100MiB.
 */
export const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
