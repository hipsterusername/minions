interface ProjectGitWarningProps {
  busy: boolean;
  onContinue: () => void;
  onInitialize: () => void;
  variant: "desktop" | "mobile";
}

export function ProjectGitWarning({
  busy,
  onContinue,
  onInitialize,
  variant,
}: ProjectGitWarningProps) {
  const mobile = variant === "mobile";
  return (
    <div role="alert" className={mobile ? "mob-project-git-warning" : "project-list-git-warning"}>
      <strong>This folder is not a Git repository</strong>
      {mobile ? (
        <span>
          Minions may run into issues without Git. Initialize it and create the first commit,
          or continue without Git.
        </span>
      ) : (
        <p>
          Minions may run into issues in projects that do not use Git. You can initialize Git
          and create the first commit now, or continue without it.
        </p>
      )}
      <div className={mobile ? "mob-project-git-actions" : "project-list-git-warning__actions"}>
        <button
          type="button"
          className={mobile ? "mob-header-action" : undefined}
          onClick={onContinue}
          disabled={busy}
        >
          Continue without Git
        </button>
        <button
          type="button"
          className={mobile ? "mob-launch-submit" : "project-list-git-warning__primary"}
          onClick={onInitialize}
          disabled={busy}
        >
          {busy
            ? (mobile ? "Initializing..." : "Initializing…")
            : (mobile ? "Initialize Git & commit" : "Initialize Git & create first commit")}
        </button>
      </div>
    </div>
  );
}
