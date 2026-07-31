import "./message-timestamp.css";

export interface FormattedMessageTimestamp {
  dateTime: string;
  label: string;
  title: string;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * Format a message time as a compact clock time, adding the date once the
 * message is no longer from today. The full local date and time remains
 * available to pointer and assistive-technology users.
 */
export function formatMessageTimestamp(
  timestamp: number,
  now = Date.now(),
): FormattedMessageTimestamp | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const date = new Date(timestamp);
  const current = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return null;

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const sameDay = isSameLocalDay(date, current);
  const label = date.toLocaleString(undefined, sameDay
    ? timeOptions
    : {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === current.getFullYear()
          ? {}
          : { year: "numeric" as const }),
        ...timeOptions,
      });
  const title = date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...timeOptions,
  });

  return {
    dateTime: date.toISOString(),
    label,
    title,
  };
}

export function MessageTimestamp({
  timestamp,
  className,
}: {
  timestamp: number;
  className?: string;
}) {
  const formatted = formatMessageTimestamp(timestamp);
  if (!formatted) return null;

  return (
    <time
      className={["message-timestamp", className].filter(Boolean).join(" ")}
      dateTime={formatted.dateTime}
      title={formatted.title}
      aria-label={formatted.title}
    >
      {formatted.label}
    </time>
  );
}
