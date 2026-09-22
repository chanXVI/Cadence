import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class Codex extends EventEmitter {
  constructor({
    command = process.env.CODEX_BIN || "codex",
    args = ["app-server", "--listen", "stdio://"],
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.pending = new Map();
    this.nextId = 0;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch((error) => {
      this.stop();
      throw error;
    });
    return this.ready;
  }
  async connect() {
    // Codex owns OAuth credentials and token refresh. Never read auth.json here.
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc = this.proc;
    proc.on("error", (error) => this.fail(error, proc));
    proc.on("exit", (code, signal) =>
      this.fail(new Error(`Codex disconnected (${signal || code}).`), proc),
    );
    proc.stdin.on("error", (error) => this.fail(error, proc));
    proc.stderr.on("data", () => {});
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method)
        this.emit(message.id != null ? "request" : "notification", message);
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    await this.call("initialize", {
      clientInfo: { name: "cadence_local", title: "Cadence", version: "0.1.0" },
    });
    this.send({ method: "initialized", params: {} });
  }
  send(message) {
    if (!this.proc || this.proc.stdin.destroyed)
      throw new Error("Codex is disconnected.");
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  fail(error, proc) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
    proc.kill();
  }
  stop() {
    if (this.proc) this.fail(new Error("Codex stopped."), this.proc);
  }
}
