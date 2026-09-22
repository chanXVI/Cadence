const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state = {
    projects: [],
    tasks: [],
    requests: [],
    paused: true,
    concurrency: 1,
  },
  projectId = "",
  selectedTask = null,
  toastTimer;
const busy = (t) =>
  ["starting", "running", "blocked", "stopping"].includes(t.status);
const columnStatus = {
  backlog: ["backlog", "failed", "cancelled"],
  todo: ["todo"],
  progress: ["starting", "running", "blocked", "stopping"],
  review: ["review"],
  done: ["done"],
};
const columnNames = {
  backlog: "Backlog",
  todo: "Todo",
  progress: "In Progress",
  review: "Review",
  done: "Done",
};
async function api(route, data) {
  const response = await fetch(
    "/api/" + route,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
function showProject() {
  $("#project-form").reset();
  $("#project-form .form-error").textContent = "";
  $("#project-dialog").showModal();
}
async function showTask() {
  if (!state.projects.length) {
    showProject();
    return;
  }
  $("#task-form").reset();
  $("#task-form .form-error").textContent = "";
  $("#task-project").innerHTML = state.projects
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join("");
  if (projectId) $("#task-project").value = projectId;
  $("#task-dialog").showModal();
  try {
    const models = await api("models");
    $("#task-model").innerHTML =
      '<option value="">Codex default</option>' +
      models.data
        .map(
          (m) =>
            `<option value="${esc(m.model)}">${esc(m.displayName || m.model)}</option>`,
        )
        .join("");
  } catch {
    /* A task can be drafted before Codex connects. */
  }
}
function render() {
  const selected = state.projects.find((p) => p.id === projectId),
    search = $("#search").value.toLowerCase();
  const tasks = state.tasks.filter(
    (t) =>
      (!projectId || t.projectId === projectId) &&
      `${t.title} ${t.description}`.toLowerCase().includes(search),
  );
  $("#breadcrumb-project").textContent = selected?.name || "All projects";
  $("#page-title").textContent = selected?.name || "Your work, in motion.";
  $("#total-count").textContent = state.tasks.length;
  $("#all-projects").classList.toggle("selected", !projectId);
  $("#projects").innerHTML = state.projects
    .map(
      (p) =>
        `<button class="nav-item ${p.id === projectId ? "selected" : ""}" data-project="${esc(p.id)}"><span>⌑</span>${esc(p.name)}<span class="count">${state.tasks.filter((t) => t.projectId === p.id).length}</span></button>`,
    )
    .join("");
  const running = state.tasks.filter(busy).length,
    waiting = state.tasks.filter((t) => t.status === "todo").length;
  $("#runner-title").textContent = state.paused
    ? running
      ? "Queue paused · agents still working"
      : "Ready when you are"
    : running
      ? `${running} agent${running === 1 ? "" : "s"} at work`
      : "Listening for your next task";
  $("#runner-description").textContent = state.paused
    ? "Queue a task, then start the runner."
    : `${waiting} queued · completed work comes back for your review`;
  $("#runner-indicator").textContent = state.paused ? "Ⅱ" : "↗";
  $("#toggle-runner").textContent = state.paused
    ? "▶ Start runner"
    : "Ⅱ Pause queue";
  $("#concurrency").value = state.concurrency;
  $("#task-count").textContent =
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  $("#board").innerHTML = Object.entries(columnStatus)
    .map(([key, statuses]) => {
      const items = tasks.filter((t) => statuses.includes(t.status));
      return `<section class="column ${key}" aria-label="${columnNames[key]}"><div class="column-heading"><span class="state-icon"></span><strong>${columnNames[key]}</strong><span class="count">${items.length}</span><button data-new-task aria-label="Create task">+</button></div>${items
        .map((t) => {
          const project = state.projects.find((p) => p.id === t.projectId);
          const label = {
            failed: "Needs attention",
            cancelled: "Stopped",
            running: "Working…",
            starting: "Starting…",
            blocked: "Needs your input",
            stopping: "Stopping…",
            review: "Ready to review",
            done: "Completed",
            todo: "Queued",
            backlog: "Draft",
          }[t.status];
          return `<button class="task-card" data-task="${t.id}"><div class="task-id">CD-${String(t.number).padStart(3, "0")}</div><h3>${esc(t.title)}</h3><div class="card-bottom"><span class="project-tag">${esc(project?.name)}</span><span class="${["failed", "blocked"].includes(t.status) ? "error-tag" : ""}">${label}</span></div></button>`;
        })
        .join(
          "",
        )}${!items.length ? `<div class="column-empty">${key === "backlog" ? "Space for your next idea" : "No tasks here yet"}</div>` : ""}</section>`;
    })
    .join("");
  $("#welcome").hidden = !!state.projects.length;
  if (selectedTask && $("#detail-dialog").open) renderDetail();
}
function renderDetail(force = false) {
  const task = state.tasks.find((t) => t.id === selectedTask);
  if (!task) return;
  const requests = state.requests.filter((r) => r.taskId === task.id);
  const signature = JSON.stringify([
    task.id,
    task.status,
    task.error,
    task.workspace,
    requests.map((r) => r.id),
  ]);
  if (force || $("#detail").dataset.signature !== signature) {
    $("#detail").dataset.signature = signature;
    const actions = busy(task)
      ? '<button data-action="stop">Stop run</button>'
      : task.status === "review"
        ? '<button class="primary" data-action="done">✓ Mark done</button><button data-action="queue">Run again</button>'
        : task.status === "todo"
          ? '<button data-action="backlog">Return to backlog</button>'
          : '<button class="primary" data-action="queue">Move to Todo →</button>';
    $("#detail").innerHTML =
      `<div class="dialog-heading"><div><span class="eyebrow">CD-${String(task.number).padStart(3, "0")} · ${esc(task.status.toUpperCase())}</span><h2>${esc(task.title)}</h2></div><button class="close icon-button" aria-label="Close">×</button></div><p class="detail-description">${esc(task.description || "No additional details.")}</p>${task.error ? `<div class="error-message">${esc(task.error)}</div>` : ""}<div class="detail-meta">${esc(state.projects.find((p) => p.id === task.projectId)?.name)} · ${esc(task.model || "Codex default model")}${task.workspace ? `<br>Workspace: <code>${esc(task.workspace)}</code><br>Branch: <code>cadence/task-${task.number}</code>` : ""}</div><div class="detail-actions">${actions}${task.workspace ? "<button data-diff>View changes</button>" : ""}</div><div id="approvals">${requests.map(requestHTML).join("")}</div><div class="detail-section"><h3>Agent output <span id="token-count"></span></h3><pre class="output" id="agent-output"></pre></div><div id="diff-section" class="detail-section" hidden><h3>Changes from the starting commit</h3><pre class="output" id="diff-output"></pre></div><div class="detail-section"><h3>Activity</h3><div id="activity"></div></div>`;
  }
  $("#agent-output").textContent =
    task.output || "Agent updates will appear here when the task runs.";
  $("#token-count").textContent = task.tokens?.totalTokens
    ? `· ${task.tokens.totalTokens.toLocaleString()} tokens`
    : "";
  const activity = $("#activity");
  if (activity.dataset.count !== String(task.events.length)) {
    activity.innerHTML =
      task.events
        .slice()
        .reverse()
        .map(
          (e) =>
            `<details class="event"><summary>${esc(new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))} · ${esc(e.kind)} · ${esc(e.text.split("\n")[0].slice(0, 90))}</summary><pre>${esc(e.text)}</pre></details>`,
        )
        .join("") || '<p class="form-note">No activity yet.</p>';
    activity.dataset.count = task.events.length;
  }
}
function requestHTML(r) {
  if (r.method === "item/tool/requestUserInput")
    return `<div class="approval" data-request="${esc(r.id)}"><strong>Codex has a question</strong>${(r.params.questions || []).map((q) => `<label>${esc(q.question)}<input data-question="${esc(q.id)}" placeholder="${esc((q.options || []).map((o) => o.label).join(" / ") || "Your answer")}"></label>`).join("")}<button data-answer>Send answer</button></div>`;
  const p = r.params,
    available = p.availableDecisions;
  return `<div class="approval" data-request="${esc(r.id)}"><strong>Approval needed</strong><pre>${esc(p.reason || r.method)}\n${esc(p.command || (p.permissions ? JSON.stringify(p.permissions, null, 2) : p.grantRoot || ""))}${p.cwd ? "\nWorking directory: " + esc(p.cwd) : ""}${p.networkApprovalContext ? "\nNetwork: " + esc(JSON.stringify(p.networkApprovalContext)) : ""}</pre>${!available || available.includes("accept") ? '<button data-decision="accept">Allow once</button>' : ""}${!available || available.includes("decline") ? '<button data-decision="decline">Decline</button>' : ""}</div>`;
}
async function refreshAccount() {
  $("#account-name").textContent = "Connecting to Codex";
  try {
    const { account, limits } = await api("account");
    const connected = account?.type === "chatgpt";
    $("#account-dot").classList.toggle("online", connected);
    $("#account-name").textContent = connected
      ? "Codex connected"
      : "ChatGPT sign-in needed";
    $("#account-detail").textContent = connected
      ? `ChatGPT ${account.planType || ""} · local session`
      : "Run codex login in your terminal";
    const windows = [
      limits?.rateLimits?.primary,
      limits?.rateLimits?.secondary,
    ].filter(Boolean);
    $("#limits").innerHTML = windows
      .map(
        (w) =>
          `<div>${esc(w.windowDurationMins >= 1440 ? Math.round(w.windowDurationMins / 1440) + "-day" : Math.round(w.windowDurationMins / 60) + "-hour")} usage · ${esc(w.usedPercent)}%<meter min="0" max="100" value="${Number(w.usedPercent)}"></meter></div>`,
      )
      .join("");
  } catch (error) {
    $("#account-name").textContent = "Codex unavailable";
    $("#account-detail").textContent = "Check CLI installation & sign-in";
    $("#account-dot").classList.remove("online");
    toast(error.message);
  }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.classList.contains("close")) {
      button.closest("dialog").close();
      return;
    }
    if (
      ["add-project", "add-project-link", "welcome-project"].includes(button.id)
    )
      return showProject();
    if (button.id === "new-task" || button.hasAttribute("data-new-task"))
      return showTask();
    if (button.id === "all-projects" || button.dataset.project) {
      projectId = button.dataset.project || "";
      render();
      return;
    }
    if (button.id === "refresh-account") return refreshAccount();
    if (button.dataset.task) {
      selectedTask = button.dataset.task;
      renderDetail(true);
      $("#detail-dialog").showModal();
      return;
    }
    button.disabled = true;
    if (button.id === "toggle-runner")
      await api("settings", { paused: !state.paused });
    if (button.dataset.action)
      await api(`tasks/${selectedTask}/action`, {
        action: button.dataset.action,
      });
    if (button.hasAttribute("data-diff")) {
      const taskId = selectedTask,
        result = await api(`tasks/${taskId}/diff`);
      if (selectedTask === taskId) {
        $("#diff-section").hidden = false;
        $("#diff-output").textContent =
          (result.diff || "No tracked changes.") +
          (result.untracked
            ? "\n\nNew files (inspect in the workspace):\n" + result.untracked
            : "");
      }
    }
    if (button.dataset.decision || button.hasAttribute("data-answer")) {
      const box = button.closest("[data-request]");
      const answers = Object.fromEntries(
        [...box.querySelectorAll("[data-question]")].map((input) => [
          input.dataset.question,
          input.value,
        ]),
      );
      await api(
        `requests/${box.dataset.request}`,
        button.dataset.decision
          ? { decision: button.dataset.decision }
          : { answers },
      );
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
for (const type of ["project", "task"])
  $(`#${type}-form`).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target,
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const result = await api(
        type === "project" ? "projects" : "tasks",
        Object.fromEntries(new FormData(form)),
      );
      if (type === "project") projectId = result.id;
      $(`#${type}-dialog`).close();
      state = await api("state");
      render();
      toast(
        type === "project"
          ? "Project added. Give it a task."
          : "Task added to Backlog.",
      );
    } catch (error) {
      form.querySelector(".form-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
$("#concurrency").addEventListener("change", async (event) => {
  try {
    await api("settings", { concurrency: Number(event.target.value) });
  } catch (error) {
    toast(error.message);
  }
});
$("#search").addEventListener("input", render);
document.addEventListener("keydown", (event) => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target.closest("input,textarea,select") ||
    document.querySelector("dialog[open]")
  )
    return;
  if (event.key === "n") {
    event.preventDefault();
    showTask();
  }
  if (event.key === "/") {
    event.preventDefault();
    $("#search").focus();
  }
});
const events = new EventSource("/api/events");
events.onmessage = (event) => {
  state = JSON.parse(event.data);
  $("#connection").textContent = "● Connected locally";
  render();
};
events.onerror = () => {
  $("#connection").textContent = "○ Reconnecting…";
};
render();
refreshAccount();
setInterval(refreshAccount, 120000);
