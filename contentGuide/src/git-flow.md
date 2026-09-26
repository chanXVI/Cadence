# Git flow in `src/harness.js`

The harness isolates each task in its own clone. It never merges or pushes. After human review, an explicit publish action can commit the workspace and fetch its task branch into the primary local repository without changing that repository's checked-out files.

## Map

```mermaid
flowchart LR
    P[Source project<br/>committed HEAD] -->|git clone --local --no-hardlinks| W[Task workspace]
    W -->|git checkout -b<br/>cadence/context--cd-N| B[Task branch]
    B -->|save HEAD SHA once| C[baseCommit]
    B -->|Codex edits files| E[Working tree changes]
    C -->|git diff baseCommit --| R[Tracked review diff]
    E -->|git ls-files --others +<br/>git diff --no-index| U[Untracked file diffs]
    R --> V[Human review]
    U --> V
    V -->|explicit publish:<br/>commit, then local fetch| L[Local task branch<br/>in source project]
```

| Moment | Git behavior |
| --- | --- |
| Add existing project | Verifies the path is the repository root and that `HEAD` exists. |
| Add blank project | Creates the primary repository at the user-chosen location, runs `git init -b main`, adds `README.md`, and creates an initial commit. |
| First task run | Clones the project into a readable project/task path, creates `cadence/<context>--cd-N`, and records its starting `HEAD` as `baseCommit`. |
| Rerun | Reuses the same workspace, branch, changes, and `baseCommit`; it does not clone or reset again. |
| Review | Shows tracked changes since `baseCommit` and includes diffs for untracked files. |
| Publish local branch | Stages and commits reviewed changes in the workspace, then fetches that branch into the primary repository. It does not check out, merge, or push. |
| Mark done | Changes board state only and warns if the result has not been published locally. |

## Scenario: first run

```mermaid
sequenceDiagram
    participant H as Harness
    participant P as Source project
    participant W as Task workspace
    participant C as Codex

    H->>P: Read committed HEAD
    H->>W: git clone --local --no-hardlinks
    H->>W: git checkout -b cadence/context--cd-N
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
    P -->|clone| W1[Workspace: login-loop--CD-0001<br/>branch cadence/login-loop--cd-0001]
    P -->|clone| W2[Workspace: add-oauth--CD-0002<br/>branch cadence/add-oauth--cd-0002]
    P -->|clone| W3[Workspace: update-docs--CD-0003<br/>branch cadence/update-docs--cd-0003]
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
    R -->|optional explicit publish| C[Commit task workspace]
    C -->|local git fetch| L[Named branch in source project]
    L -. no checkout or merge .-> P[Source working tree unchanged]
    R -->|Mark done| X[Board status: done]
    R -. no automatic integration .-> P
```

The original `baseCommit` remains the comparison point across attempts, so review covers the task's accumulated tracked changes.

## Operational boundaries

- The task instructions explicitly prohibit push, merge, and publish operations.
- The task branch may contain uncommitted edits; the harness does not require Codex to commit. Cadence commits only after the user explicitly selects **Publish local branch**.
- Review presents the tracked diff and separate untracked-file diffs before publication.
- Publishing uses a filesystem path between local repositories, so no GitHub or other hosted remote is required.
- Git rejects a non-fast-forward update or an update to a checked-out destination branch. The workspace commit remains available if the fetch fails.
- Decreasing concurrency or pausing the queue does not combine or move Git branches; it only controls future dispatch.
