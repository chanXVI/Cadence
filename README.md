# Cadence

Cadence is a local task board and coding-agent harness. Add a project, describe a task, and let the runner start Codex in a separate Git clone. Follow its progress in your browser, respond to approval requests, and review the resulting changes.

This is an early, dependency-free implementation using Node.js and plain HTML, CSS, and JavaScript. It connects to the installed Codex CLI through `codex app-server` over standard input/output and requires a ChatGPT-authenticated account before starting a task. Codex manages sign-in credentials and token refresh; Cadence does not read or copy OAuth tokens.

The workflow is inspired by [OpenAI Symphony](https://github.com/openai/symphony). The TODO App board in Symphony's demo is Linear; Symphony's included dashboard is a separate monitoring interface. Cadence implements its own local board and runner, with no Linear integration or Symphony runtime dependency.

## Requirements

- Node.js 22 or newer, with npm.
- Git available on your `PATH`.
- Codex CLI available on your `PATH`, with support for `app-server`.
- A ChatGPT sign-in in the Codex CLI. API-key accounts are rejected by the task runner.

## Start locally

From this repository:

```sh
node --version
git --version
codex --version
codex login status
```

If you need to sign in, run `codex login` and choose ChatGPT sign-in. Then start Cadence:

```sh
npm start
```

Open **http://127.0.0.1:4310** in your browser. There are no npm dependencies to install and no frontend build step. The sidebar displays the account connection and usage limits when Codex provides them.

For server development, use `npm run dev` to restart Node when files change. Refresh the browser after frontend edits. Stop the server with `Ctrl+C`.

## Run your first task

1. Select **Add a project**. Enter the root path of a local Git repository with at least one commit, or leave the path blank to create a fresh repository.
2. Select **New task**, choose the project, and enter a title and acceptance criteria. Select a model or keep **Codex default**.
3. Open the task in **Backlog** and select **Move to Todo**.
4. Select **Start runner**. The runner starts paused by default. Choose between one and three concurrent tasks with **Active agents**.
5. Open the running task to follow agent output and activity. Answer questions or allow/decline supported approval requests there.
6. When the task reaches **Review**, select **View changes** and inspect the workspace path shown in the task. Run the project's checks there, then select **Mark done** when satisfied.

For a simple manual trial, create a fresh project and use:

> Create a simple todo app using plain HTML, CSS, and JavaScript. Support adding, completing, and deleting tasks, and persist them in localStorage. Explain how to run and manually verify the app.

The generated app lives in the task's workspace. Cadence does not automatically launch or embed a preview of it.

## What is implemented

- Five board columns: **Backlog**, **Todo**, **In Progress**, **Review**, and **Done**.
- Project filtering, task search, model selection, and keyboard shortcuts: `N` for a new task and `/` for search.
- A local queue with one to three concurrent tasks, queue pause/resume, and individual run interruption.
- A separate Git clone and `cadence/task-<number>` branch for each task.
- Live browser updates through Server-Sent Events, including agent output, command activity, changed-file activity, and token usage when reported.
- Command, file-change, and permission approval requests, plus text responses to agent questions.
- A review view with tracked-file diffs against the starting commit and a list of untracked files.
- Manual reruns using the existing task workspace and a new Codex thread.
- Local JSON persistence for projects, tasks, settings, and bounded output/activity history.
- A loopback-only HTTP server with same-origin checks and a Content Security Policy.

### Queue and review behavior

New tasks start in Backlog. Queued tasks run in creation order when capacity is available. Failed and stopped tasks appear in Backlog with their status and can be queued again.

**Pause queue** prevents new tasks from starting; active tasks continue. Use **Stop run** inside a task to interrupt it. Tasks waiting for approval or input still occupy a concurrency slot.

A completed Codex turn moves the task to Review. This means the agent finished its turn; it does not certify that tests passed. **Mark done** updates the board status only. The harness does not merge, push, or publish the result.

Every server start pauses the queue. Previously active tasks become failed and require manual review and requeueing. A Codex disconnection also pauses the queue and fails active tasks. Task startup errors pause dispatch; a later failed agent turn marks that task failed without necessarily pausing the queue.

### Workspace behavior

The first run clones the project's committed Git state. Uncommitted changes and untracked files in the source project are not copied. Each task works in its own clone; results are not automatically applied to the source repository or shared with other tasks.

Rerunning a task retains its workspace changes and original comparison commit. It starts a new Codex conversation with the same title and description, rather than resuming the previous conversation or refreshing from the source repository.

Codex is started with the `workspace-write` sandbox and `on-request` approval policy. Its task instructions ask it to inspect project instructions, make and verify changes, and summarize the result for human review. They also instruct it not to push, merge, publish, contact others, or create additional agents. A separate Git clone is working-copy separation, not a container or virtual machine.

## Configuration and storage

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP port; the server binds to `127.0.0.1`. |
| `CODEX_BIN` | `codex` | Codex executable name or path. |
| `HARNESS_DATA_DIR` | `.harness` in this repository | Persistent state and managed repositories/workspaces. |

Example:

```sh
PORT=4311 CODEX_BIN=/absolute/path/to/codex npm start
```

Default data layout:

```text
.harness/
  state.json                 Projects, tasks, settings, and run history
  projects/<project-id>/     Repositories created with a blank project path
  workspaces/<task-id>/      Task clones and generated work
```

`.harness/` is ignored by Git. It contains project files and task output, so preserve it if you want to retain your work. Pending approval requests are held in memory and do not survive a server restart.

## Source layout

```text
src/codex.js        Codex app-server process and JSON message bridge
src/harness.js      Persistence, scheduling, Git workspaces, and run lifecycle
src/server.js       Local HTTP API, static assets, and event stream
public/index.html  Board, forms, and task detail dialogs
public/app.js       Browser state, rendering, and API interactions
public/style.css   Layout and styling
```

## Validation and current limitations

JavaScript syntax checks passed during the initial implementation. A complete browser flow and a real agent task have not yet been verified. The manual trial above is the next validation step.

The `npm test` script invokes Node's test runner, but no automated tests have been added yet. To repeat the syntax checks:

```sh
node --check src/codex.js
node --check src/harness.js
node --check src/server.js
node --check public/app.js
```

Current scope is a single-user local prototype:

- No Linear/GitHub issue synchronization, Symphony `WORKFLOW.md` support, automatic PR creation, or merging.
- No task/project editing or deletion, drag-and-drop board movement, or follow-up prompt editor.
- No automatic retries, stalled-run recovery, or conversation resumption after restart.
- New untracked files are listed in **View changes**, but their contents must be inspected in the workspace.
- Approval handling supports a limited set of app-server interactions and basic allow/decline decisions; other interactions are rejected as unsupported.
- No hosted deployment, remote access authentication, workspace cleanup, or complete audit-log retention.

## Troubleshooting

- **Codex unavailable:** Check `codex --version` and `codex login status`. Set `CODEX_BIN` if the executable is outside the server's `PATH`, then restart Cadence and refresh the sidebar connection.
- **Project cannot be added:** Use the repository root, confirm it exists locally, and ensure it has at least one commit.
- **Task stays in Todo:** Start the runner and check whether existing tasks are using all slots or waiting for input.
- **Task fails:** Open its details for the error and activity. Review any existing workspace before moving it back to Todo.
- **Port already in use:** Stop the other instance or use a different `PORT` and open that port in your browser.
