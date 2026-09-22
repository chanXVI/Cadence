import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
const exec = promisify(execFile);
export const git = (cwd, ...args) =>
  exec("git", ["-C", cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  });
export const active = (task) =>
  ["starting", "running", "blocked", "stopping"].includes(task.status);
const clean = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export class Harness extends EventEmitter {
  constructor(root, codex) {
    super();
    this.root = path.resolve(root);
    this.codex = codex;
    this.requests = new Map();
    this.dispatching = false;
    this.closed = false;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.file = path.join(this.root, "state.json");
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { projects: [], tasks: [], concurrency: 1, paused: true };
    }
    this.state.paused = true;
    for (const task of this.state.tasks)
      if (active(task)) {
        task.status = "failed";
        task.error =
          "Server restarted during this run. Review the workspace, then retry.";
      }
    this.save();
    codex.on("notification", (message) => this.notification(message));
    codex.on("request", (message) => this.request(message));
    codex.on("disconnect", (error) => {
      this.requests.clear();
      this.state.paused = true;
      for (const task of this.state.tasks)
        if (active(task)) {
          task.status = "failed";
          task.error = error.message;
        }
      this.save();
    });
  }
  save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
    this.emit("change");
  }
  snapshot() {
    return { ...this.state, requests: [...this.requests.values()] };
  }
  task(id) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error("Task not found.");
    return task;
  }
  async addProject(input) {
    let repo;
    const name = clean(input.name, 100);
    if (!name) throw new Error("Give the project a name.");
    if (input.path) {
      repo = realpathSync(clean(input.path, 2000));
      const top = (
        await git(repo, "rev-parse", "--show-toplevel")
      ).stdout.trim();
      if (realpathSync(top) !== repo)
        throw new Error("Choose the root folder of a Git repository.");
      await git(repo, "rev-parse", "--verify", "HEAD");
    } else {
      repo = path.join(this.root, "projects", randomUUID());
      mkdirSync(repo, { recursive: true });
      await git(repo, "init", "-b", "main");
      writeFileSync(
        path.join(repo, "README.md"),
        `# ${name}\n\nCreated with Cadence.\n`,
      );
      await git(repo, "add", "README.md");
      await git(
        repo,
        "-c",
        "user.name=Cadence",
        "-c",
        "user.email=cadence@localhost",
        "commit",
        "-m",
        "Initialize project",
      );
    }
    const project = { id: randomUUID(), name, path: repo };
    this.state.projects.push(project);
    this.save();
    return project;
  }
  addTask(input) {
    const title = clean(input.title, 200),
      description = clean(input.description, 16000);
    if (!title) throw new Error("Give the task a title.");
    if (!this.state.projects.some((p) => p.id === input.projectId))
      throw new Error("Choose a project.");
    const task = {
      id: randomUUID(),
      number: this.state.tasks.length + 1,
      title,
      description,
      projectId: input.projectId,
      status: "backlog",
      model: clean(input.model, 150),
      createdAt: new Date().toISOString(),
      events: [],
      attempt: 0,
    };
    this.state.tasks.push(task);
    this.save();
    return task;
  }
  log(task, kind, text) {
    task.events.push({
      at: new Date().toISOString(),
      kind,
      text: String(text).slice(0, 20000),
    });
    task.events = task.events.slice(-300);
  }
  async action(id, action) {
    const task = this.task(id);
    if (action === "stop") {
      if (!active(task)) throw new Error("This task is not running.");
      task.status = "stopping";
      this.save();
      if (task.threadId && task.turnId)
        await this.codex.call("turn/interrupt", {
          threadId: task.threadId,
          turnId: task.turnId,
        });
      return;
    }
    if (active(task))
      throw new Error("Stop the current run before changing this task.");
    if (action === "queue") task.status = "todo";
    else if (action === "backlog") task.status = "backlog";
    else if (action === "done" && task.status === "review")
      task.status = "done";
    else throw new Error("That action is not available.");
    task.error = null;
    this.save();
  }
  settings(input) {
    if (typeof input.paused === "boolean") this.state.paused = input.paused;
    if (input.concurrency !== undefined) {
      if (![1, 2, 3].includes(input.concurrency))
        throw new Error("Concurrency must be 1, 2, or 3.");
      this.state.concurrency = input.concurrency;
    }
    this.save();
  }
  async tick() {
    if (this.closed || this.dispatching || this.state.paused) return;
    this.dispatching = true;
    try {
      while (
        !this.closed &&
        !this.state.paused &&
        this.state.tasks.filter(active).length < this.state.concurrency
      ) {
        const task = this.state.tasks.find((t) => t.status === "todo");
        if (!task) break;
        task.status = "starting";
        task.turnId = null;
        task.threadId = null;
        this.save();
        try {
          await this.run(task);
        } catch (error) {
          task.status = "failed";
          task.error = error.message;
          this.log(task, "error", error.message);
          this.state.paused = true;
          this.save();
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
  async run(task) {
    await this.codex.start();
    const { account } = await this.codex.call("account/read", {
      refreshToken: false,
    });
    if (account?.type !== "chatgpt")
      throw new Error(
        "Run codex login with ChatGPT before starting the queue.",
      );
    const project = this.state.projects.find((p) => p.id === task.projectId);
    if (!task.workspace) {
      const workspace = path.join(this.root, "workspaces", task.id);
      mkdirSync(path.dirname(workspace), { recursive: true });
      await exec(
        "git",
        ["clone", "--local", "--no-hardlinks", "--", project.path, workspace],
        { timeout: 30000 },
      );
      task.workspace = workspace;
      await git(workspace, "checkout", "-b", `cadence/task-${task.number}`);
      task.baseCommit = (
        await git(workspace, "rev-parse", "HEAD")
      ).stdout.trim();
    }
    if (task.status === "stopping" || this.closed) {
      task.status = "cancelled";
      this.save();
      return;
    }
    task.attempt++;
    task.startedAt = new Date().toISOString();
    task.output = "";
    task.diff = "";
    const { thread } = await this.codex.call("thread/start", {
      cwd: task.workspace,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      ...(task.model ? { model: task.model } : {}),
      developerInstructions:
        "Work on the assigned task in this isolated repository. Inspect project instructions. Make and verify the changes. Do not push, merge, publish, or contact others. Do not create other agents. Finish with a summary of changes, tests, and limitations for human review.",
    });
    task.threadId = thread.id;
    if (task.status === "stopping" || this.closed) {
      task.status = "cancelled";
      this.save();
      return;
    }
    task.status = "running";
    this.log(
      task,
      "system",
      `Run ${task.attempt} started in an isolated copy.`,
    );
    this.save();
    const { turn } = await this.codex.call("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: `${task.title}\n\n${task.description}`,
          text_elements: [],
        },
      ],
    });
    task.turnId = turn.id;
    if (task.status === "stopping")
      await this.codex.call("turn/interrupt", {
        threadId: task.threadId,
        turnId: task.turnId,
      });
    this.save();
  }
  notification({ method, params: p = {} }) {
    if (method === "account/updated" || method === "account/login/completed") {
      this.emit("account");
      return;
    }
    const task = this.state.tasks.find(
      (t) => t.threadId && t.threadId === p.threadId,
    );
    if (!task) return;
    if (method === "item/agentMessage/delta")
      task.output = ((task.output || "") + p.delta).slice(-100000);
    else if (method === "turn/started") task.turnId = p.turn.id;
    else if (method === "turn/diff/updated")
      task.diff = (p.diff || "").slice(0, 200000);
    else if (method === "thread/tokenUsage/updated")
      task.tokens = p.tokenUsage?.total;
    else if (method === "item/completed") {
      const item = p.item;
      if (item.type === "agentMessage") this.log(task, "agent", item.text);
      else if (item.type === "commandExecution")
        this.log(
          task,
          "command",
          `${item.command}\n${item.aggregatedOutput || ""}`,
        );
      else if (item.type === "fileChange")
        this.log(
          task,
          "files",
          (item.changes || []).map((c) => c.path).join("\n"),
        );
    } else if (method === "serverRequest/resolved") {
      this.requests.delete(String(p.requestId));
      if (
        task.status === "blocked" &&
        ![...this.requests.values()].some((r) => r.taskId === task.id)
      )
        task.status = "running";
    } else if (method === "turn/completed") {
      task.status =
        p.turn.status === "completed"
          ? "review"
          : p.turn.status === "interrupted"
            ? "cancelled"
            : "failed";
      task.error = p.turn.error?.message;
      task.finishedAt = new Date().toISOString();
      for (const [id, request] of this.requests)
        if (request.taskId === task.id) this.requests.delete(id);
      this.log(task, "system", `Run finished: ${task.status}.`);
    } else if (method === "error")
      this.log(task, "error", p.error?.message || "Agent error");
    else return;
    this.save();
  }
  request(message) {
    const task = this.state.tasks.find(
      (t) => t.threadId === message.params?.threadId,
    );
    if (!task) {
      this.codex.send({
        id: message.id,
        error: { code: -32601, message: "No active task for this request." },
      });
      return;
    }
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
    ];
    if (!supported.includes(message.method)) {
      this.codex.send({
        id: message.id,
        error: {
          code: -32601,
          message: "This local harness does not support this interaction.",
        },
      });
      this.log(task, "error", `Unsupported interaction: ${message.method}`);
      this.save();
      return;
    }
    this.requests.set(String(message.id), { ...message, taskId: task.id });
    task.status = "blocked";
    this.save();
  }
  answer(id, input) {
    const request = this.requests.get(id);
    if (!request) throw new Error("This request has already been resolved.");
    let result;
    if (request.method === "item/tool/requestUserInput") {
      result = {
        answers: Object.fromEntries(
          (request.params.questions || []).map((q) => {
            const answer = clean(input.answers?.[q.id], 8000);
            if (!answer) throw new Error("Answer each question.");
            return [q.id, { answers: [answer] }];
          }),
        ),
      };
    } else {
      if (!["accept", "decline"].includes(input.decision))
        throw new Error("Choose allow or decline.");
      if (request.method === "item/permissions/requestApproval")
        result = {
          permissions:
            input.decision === "accept" ? request.params.permissions : {},
          scope: "turn",
        };
      else {
        const available = request.params.availableDecisions;
        if (available && !available.includes(input.decision))
          throw new Error("This decision is not offered for this request.");
        result = { decision: input.decision };
      }
    }
    this.codex.send({ id: request.id, result });
    this.requests.delete(id);
    const task = this.task(request.taskId);
    if (
      task.status === "blocked" &&
      ![...this.requests.values()].some((r) => r.taskId === task.id)
    )
      task.status = "running";
    this.save();
  }
  async diff(id) {
    const task = this.task(id);
    if (!task.workspace) return { diff: "", untracked: "" };
    const [{ stdout: diff }, { stdout: untracked }] = await Promise.all([
      git(task.workspace, "diff", task.baseCommit, "--"),
      git(task.workspace, "ls-files", "--others", "--exclude-standard"),
    ]);
    return { diff, untracked };
  }
  close() {
    this.closed = true;
    this.codex.stop();
  }
}
