export class TaskGraphConflictError extends Error {
  constructor(message: string, readonly latest: unknown = null) {
    super(message); this.name = "TaskGraphConflictError";
  }
}
export class TaskGraphValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TaskGraphValidationError"; }
}
