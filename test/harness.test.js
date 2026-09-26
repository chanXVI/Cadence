import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness, git, slugify } from "../src/harness.js";

const temporaryDirectories = [];

class FakeCodex extends EventEmitter {
  async start() {}
  async call(method) {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    throw new Error(`Unexpected Codex call: ${method}`);
  }
  stop() {}
}

const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cadence-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("slugify produces short, readable context", () => {
  assert.equal(slugify("Add a dark theme", 3, "task"), "add-dark-theme");
  assert.equal(slugify("  Héllo, API world! ", 3, "task"), "hello-api-world");
  assert.equal(slugify("the and to", 3, "task"), "the-and-to");
});

test("new projects are created at a user-facing location", async () => {
  const root = temporaryDirectory(),
    projectsDirectory = path.join(root, "projects"),
    harness = new Harness(path.join(root, "data"), new FakeCodex(), {
      projectsDirectory,
    }),
    projectPath = path.join(projectsDirectory, "inventory-service"),
    project = await harness.addProject({
      name: "Inventory Service",
      mode: "create",
      path: projectPath,
    });

  assert.equal(project.path, projectPath);
  assert.equal(project.slug, "inventory-service");
  assert.equal(project.managed, true);
  assert.match(readFileSync(path.join(projectPath, "README.md"), "utf8"), /Inventory Service/);
  assert.equal((await git(projectPath, "branch", "--show-current")).stdout.trim(), "main");

  await assert.rejects(
    harness.addProject({
      name: "Hidden Project",
      mode: "create",
      path: path.join(root, "data", "projects", "hidden-project"),
    }),
    /outside Cadence's internal data directory/,
  );
});

test("task results use contextual names and publish to a local branch", async () => {
  const root = temporaryDirectory(),
    harness = new Harness(path.join(root, "data"), new FakeCodex(), {
      projectsDirectory: path.join(root, "projects"),
    }),
    project = await harness.addProject({
      name: "Inventory Service",
      mode: "create",
      path: path.join(root, "projects", "inventory-service"),
    }),
    task = harness.addTask({
      projectId: project.id,
      title: "Fix expired session handling",
      context: "fix session",
    }),
    projectFolder = `${project.slug}--${project.id.replaceAll("-", "").slice(0, 8)}`,
    workspace = path.join(
      root,
      "data",
      "workspaces",
      projectFolder,
      "fix-session--CD-0001",
    );

  await harness.run(task);
  assert.equal(task.workspace, workspace);
  assert.equal(
    (await git(workspace, "branch", "--show-current")).stdout.trim(),
    task.branch,
  );
  task.status = "review";
  writeFileSync(path.join(workspace, "session.js"), "export const valid = true;\n");

  const review = await harness.diff(task.id);
  assert.match(review.untracked, /session\.js/);
  assert.match(review.untrackedDiff, /export const valid = true/);

  const result = await harness.publish(task.id);
  assert.equal(result.branch, "cadence/fix-session--cd-0001");
  assert.equal(task.publishedCommit, result.commit);
  assert.equal(
    (await git(project.path, "rev-parse", result.branch)).stdout.trim(),
    result.commit,
  );
  assert.equal(
    (await git(project.path, "show", `${result.branch}:session.js`)).stdout,
    "export const valid = true;\n",
  );
  assert.equal((await git(project.path, "branch", "--show-current")).stdout.trim(), "main");
});
