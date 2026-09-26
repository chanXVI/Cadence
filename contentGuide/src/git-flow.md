# Git flow in `src/harness.js`

The harness isolates each task in its own clone. It never merges, pushes, or copies task changes back to the source project.

## Map

```mermaid
flowchart LR
    P[Source project<br/>committed HEAD] -->|git clone --local --no-hardlinks| W[Task workspace]
    W -->|git checkout -b<br/>cadence/task-N| B[Task branch]
    B -->|save HEAD SHA once| C[baseCommit]
    B -->|Codex edits files| E[Working tree changes]
    C -->|git diff baseCommit --| R[Tracked review diff]
    E -->|git ls-files --others<br/>--exclude-standard| U[Untracked file list]
    R --> V[Human review]
    U --> V
```

| Moment | Git behavior |
| --- | --- |
| Add existing project | Verifies the path is the repository root and that `HEAD` exists. |
| Add blank project | Runs `git init -b main`, adds `README.md`, and creates an initial commit. |
| First task run | Clones the project, creates `cadence/task-N`, and records its starting `HEAD` as `baseCommit`. |
| Rerun | Reuses the same workspace, branch, changes, and `baseCommit`; it does not clone or reset again. |
| Review | Shows tracked changes since `baseCommit` and lists untracked files. |
| Mark done | Changes board state only; no commit, merge, push, or source-repository update occurs. |

## Scenario: first run

```mermaid
sequenceDiagram
    participant H as Harness
    participant P as Source project
    participant W as Task workspace
    participant C as Codex

    H->>P: Read committed HEAD
    H->>W: git clone --local --no-hardlinks
    H->>W: git checkout -b cadence/task-N
    H->>W: git rev-parse HEAD
    W-->>H: baseCommit
    H->>C: Start thread with cwd = workspace
    C->>W: Edit and verify files
    Note over P,W: Source project remains unchanged
```

Only committed source state is cloned. Source-project uncommitted and untracked files are absent from the task workspace.

## Scenario: concurrent tasks

```mermaid
flowchart TB
    P[Source project HEAD]
    P -->|clone| W1[Workspace: task A<br/>branch cadence/task-1]
    P -->|clone| W2[Workspace: task B<br/>branch cadence/task-2]
    P -->|clone| W3[Workspace: task C<br/>branch cadence/task-3]
    W1 --> A[Codex run A]
    W2 --> B[Codex run B]
    W3 --> C[Codex run C]
```

Each active task edits a separate clone, so concurrent runs do not share working-tree changes. A later task still clones the source project, not another task's workspace.

## Scenario: rerun and review

```mermaid
flowchart LR
    F[Failed or cancelled task] -->|queue again| S[Same workspace and branch]
    S -->|new Codex thread| E[More edits]
    E --> D[git diff baseCommit --]
    E --> U[git ls-files --others<br/>--exclude-standard]
    D --> R[Review]
    U --> R
    R -->|Mark done| X[Board status: done]
    R -. no automatic merge .-> P[Source project unchanged]
```

The original `baseCommit` remains the comparison point across attempts, so review covers the task's accumulated tracked changes.

## Operational boundaries

- The task instructions explicitly prohibit push, merge, and publish operations.
- The task branch may contain uncommitted edits; the harness does not require Codex to commit.
- Untracked file names appear in review, but their contents are not included in the tracked diff.
- Decreasing concurrency or pausing the queue does not combine or move Git branches; it only controls future dispatch.
