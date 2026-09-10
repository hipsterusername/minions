# Launcher lifecycle and bounded logs

The background launcher preserves numeric `.run/minions.pid` compatibility and
normal `pnpm start`, `pnpm stop`, and `pnpm restart`. It does not leave a manual
recovery fence after ordinary shutdown. Stop waits for the runner before removing
its PID record. These commands report process state, not application readiness.

Every backend generation receives exit/error supervision. On POSIX, the backend
starts in its own process group; explicit exit-42 restart in development sends
TERM, allows a one-second grace period, then sends KILL to that owned group before
replacement. Stop and service failure use the same cleanup. The frontend is also
stopped. Unexpected crashes have zero automatic retries: the runner exits with a
failure rather than repeatedly replaying interrupted agent work. Durable recovery
continues to use the invocation ledger and never treats an uncertain run as a
successful completed turn.

Process groups cover managed descendants that remain in the group; they do not
contain deliberately detached/daemonized commands. This is not an OS sandbox or a
claim to terminate arbitrary user-created daemons. On Windows, explicit `pnpm
restart` stops the live runner tree with taskkill before starting again. In-process
exit-42 replacement is refused there because a departed root cannot reliably
identify its descendants. Windows runtime behavior needs platform CI verification.

The runner exclusively owns background log output and closes/reopens its file
on rotation. Five segments of at most 20 MiB bound log data to 100 MiB. Adoption of
an oversized old log retains its newest segment using a 64 KiB copying buffer;
session history is unchanged. Child streams supply bounded chunks and synchronous
file writes avoid an unbounded application writer queue. Storage stalls may delay
the runner, and byte-based rotation may split UTF-8 characters. External writers
must not keep appending to the same log descriptor.

Nine targeted Linux process/log regressions passed during integration, including
repeated replacements, stop/start, partial startup failure, descendant cleanup,
rotation and legacy-log adoption. The test environment required a temporary
blocking-stdio preload; no production preload was added. Production rollout and
Windows execution are separate from these isolated fixture results.
