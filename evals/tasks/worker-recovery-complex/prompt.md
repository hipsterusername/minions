# Persistent worker recovery

Repair `src/index.mjs`, a dependency-free Node 22 worker that duplicates locally
committed effects when restarted. Run `node src/index.mjs` with one JSON request
on stdin: `{directory, now, leaseMs, retryMs, crashAt?}`. The directory already
exists and holds `state.json`; see `example.json` for an initial state. Use a
separate directory per queue. Each invocation drains eligible jobs once in array
order and exits 0, printing JSON `{pid}` with its actual process ID. Calls are
serialized (no two live workers execute simultaneously); leases survive process
exit. Do not wait for wall time: `now` is an injected integer clock. Inputs use
safe integers, positive lease/retry durations, unique nonempty job IDs, and
nonnegative integer `failures`. No network or dependencies are required.

Persist the exact state shape `{jobs, effects}`. A job is
`{id,value,failures,status,attempts,availableAt,leaseUntil}`. Initial jobs have
`status: "ready"`, `attempts: 0`, `availableAt: 0`, `leaseUntil: null`.
`effects` is an append-only journal of `{jobId,value}` records, initially empty;
value is the job's integer payload. Preserve jobs and their array order.

- Skip done jobs, ready jobs with `availableAt > now`, and claimed jobs with
  `leaseUntil > now`. At equality a job is eligible. Claim by persisting
  `status: "claimed"`, `leaseUntil: now + leaseMs`, and incrementing attempts.
- On each of the first `failures` attempts, simulate a transient failure after
  claiming: persist ready status, null lease and `availableAt: now + retryMs`.
  Continue other jobs. Each invocation attempts each job at most once; retries
  have no maximum and must eventually succeed when the clock advances.
- On success commit exactly one journal record keyed by job ID, then acknowledge
  done status with a null lease in a separate persisted transaction. Retrying an
  already committed effect must not append another record or change its value.
- Preserve the last committed queue and journal across process death. Atomic
  file replacement of a combined snapshot is sufficient; flush the snapshot
  and directory. An abandoned temporary snapshot is not committed state.
- Optional `crashAt` is `after-claim`, `before-effect`, or `after-effect`. At the
  first reached matching checkpoint terminate the actual worker with SIGKILL
  (no caught exception or normal exit). `after-claim` follows durable claim and
  precedes transient-failure handling. `before-effect` follows successful failure
  handling, immediately before the idempotent effect boundary. `after-effect`
  follows that boundary and precedes acknowledgement, including deduplicated
  attempts. No crash occurs if no job reaches the selected checkpoint.

Recovery before expiry must leave the crashed job unchanged while allowing other
ready jobs to finish. Recovery at expiry must reclaim it. All completed jobs
must remain unchanged on subsequent invocations. This is an idempotent local
transaction boundary, not exactly-once delivery to arbitrary external services.
Do not change the CLI or state schema. Grading reads persisted state directly;
printing a successful-looking response does not commit an effect.
