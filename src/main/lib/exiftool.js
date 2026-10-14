"use strict";

const { spawn } = require("node:child_process");
const { CancelledError, UserError } = require("./util");

// Options added to every command: UTF-8 file names, QuickTime dates read and
// written as real UTC instants (shown in local time with a zone offset), and
// files over 2 GB.
const COMMON_ARGS = ["-charset", "filename=utf8", "-api", "QuickTimeUTC=1", "-api", "LargeFileSupport=1"];

/**
 * One `exiftool -stay_open True -@ -` process. Commands are written to stdin
 * one argument per line and finished with -executeN; exiftool prints
 * {readyN} on stdout when done, and -echo4 puts the same marker on stderr so
 * we know that command's warnings are complete too.
 */
class ExifToolProcess {
  constructor(perl, script) {
    this.perl = perl;
    this.script = script;
    this.child = null;
    this.current = null;
    this.counter = 0;
  }

  start() {
    const child = spawn(this.perl, [this.script, "-stay_open", "True", "-@", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData("stdout", chunk));
    child.stderr.on("data", (chunk) => this._onData("stderr", chunk));
    child.on("error", (err) => this._fail(err));
    child.on("exit", (code, sig) => {
      if (this.child === child) this.child = null;
      this._fail(new Error(`ExifTool stopped unexpectedly (${sig || `exit ${code}`})`));
    });
    child.stdin.on("error", () => {});
    this.child = child;
  }

  get busy() {
    return this.current !== null;
  }

  run(args, { timeoutMs = 120000, signal } = {}) {
    for (const a of args) {
      if (/[\r\n]/.test(a)) {
        return Promise.reject(new UserError("A file name contains a line break, which ExifTool can't handle."));
      }
    }
    if (!this.child) this.start();
    const id = ++this.counter;
    const marker = `{ready${id}}`;
    return new Promise((resolve, reject) => {
      const task = {
        id,
        marker,
        stdout: "",
        stderr: "",
        gotOut: false,
        gotErr: false,
        resolve,
        reject,
        timer: null,
        onAbort: null,
      };
      task.timer = setTimeout(() => {
        this._kill();
        this._settle(task, new Error("ExifTool took too long and was restarted."));
      }, timeoutMs);
      if (signal) {
        task.onAbort = () => {
          this._kill();
          this._settle(task, new CancelledError());
        };
        if (signal.aborted) {
          clearTimeout(task.timer);
          reject(new CancelledError());
          return;
        }
        signal.addEventListener("abort", task.onAbort, { once: true });
        task.signal = signal;
      }
      this.current = task;
      const lines = [...COMMON_ARGS, ...args, "-echo4", marker, `-execute${id}`];
      this.child.stdin.write(`${lines.join("\n")}\n`);
    });
  }

  _onData(stream, chunk) {
    const task = this.current;
    if (!task) return;
    if (stream === "stdout") {
      task.stdout += chunk;
      const at = task.stdout.indexOf(task.marker);
      if (at >= 0) {
        task.gotOut = true;
        task.stdout = task.stdout.slice(0, at);
      }
    } else {
      task.stderr += chunk;
      const at = task.stderr.indexOf(task.marker);
      if (at >= 0) {
        task.gotErr = true;
        task.stderr = task.stderr.slice(0, at);
      }
    }
    if (task.gotOut && task.gotErr) this._settle(task, null);
  }

  _settle(task, err) {
    if (this.current !== task) return;
    this.current = null;
    clearTimeout(task.timer);
    if (task.signal && task.onAbort) task.signal.removeEventListener("abort", task.onAbort);
    if (err) task.reject(err);
    else task.resolve({ stdout: task.stdout.trim(), stderr: task.stderr.trim() });
  }

  _fail(err) {
    if (this.current) this._settle(this.current, err);
  }

  _kill() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.write("-stay_open\nFalse\n");
      child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, 1000).unref();
  }
}

/** A small pool of exiftool processes with a shared FIFO queue. */
class ExifTool {
  constructor({ perl, script, size = 2 }) {
    this.perl = perl;
    this.script = script;
    this.procs = Array.from({ length: size }, () => new ExifToolProcess(perl, script));
    this.queue = [];
    this.version = null;
  }

  run(args, options = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ args, options, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    for (const proc of this.procs) {
      if (!this.queue.length) return;
      if (proc.busy) continue;
      const job = this.queue.shift();
      if (job.options.signal && job.options.signal.aborted) {
        job.reject(new CancelledError());
        continue;
      }
      proc
        .run(job.args, job.options)
        .then(job.resolve, job.reject)
        .finally(() => this._pump());
    }
  }

  /** Runs a read command with -j and returns the parsed array (one object per file). */
  async readJson(files, tagArgs = [], options = {}) {
    if (!files.length) return [];
    const { stdout, stderr } = await this.run(["-j", ...tagArgs, ...files], options);
    if (!stdout) {
      if (stderr && files.length === 1) throw new UserError(cleanError(stderr));
      return [];
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`ExifTool returned unreadable output: ${stdout.slice(0, 200)}`);
    }
  }

  /**
   * Writes tags to one file. `assignments` is a list of ["Tag", value]; a null
   * or "" value deletes the tag. Returns { updated, warnings }.
   */
  async write(file, assignments, { extraArgs = [], signal, timeoutMs } = {}) {
    const args = ["-overwrite_original_in_place", "-P", "-m", ...extraArgs];
    for (const [tag, value] of assignments) {
      args.push(`-${tag}=${value === null || value === undefined ? "" : value}`);
    }
    args.push(file);
    const { stdout, stderr } = await this.run(args, { signal, timeoutMs: timeoutMs || 600000 });
    return parseWriteResult(stdout, stderr);
  }

  async getVersion() {
    if (this.version) return this.version;
    const { stdout } = await this.run(["-ver"]);
    this.version = stdout.trim();
    return this.version;
  }

  close() {
    for (const proc of this.procs) proc.close();
  }
}

function cleanError(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/^(Error|Warning):\s*/, "").replace(/ - \/.*$/, ""))
    .filter(Boolean)
    .join("; ");
}

function parseWriteResult(stdout, stderr) {
  const updated = /(\d+) image files? updated/.exec(stdout);
  const unchanged = /(\d+) image files? unchanged/.exec(stdout);
  const errors = stderr
    .split("\n")
    .filter((l) => /^Error/.test(l))
    .map((l) => cleanError(l));
  const warnings = stderr
    .split("\n")
    .filter((l) => /^Warning/.test(l))
    .map((l) => cleanError(l));
  const result = {
    updated: updated ? Number(updated[1]) : 0,
    unchanged: unchanged ? Number(unchanged[1]) : 0,
    warnings,
  };
  if (errors.length || (!result.updated && !result.unchanged)) {
    const message = errors.join("; ") || cleanError(stderr) || "ExifTool could not write this file";
    const err = new UserError(message);
    err.result = result;
    throw err;
  }
  return result;
}

/** Splits a "-G0:1" JSON key ("EXIF:ExifIFD:DateTimeOriginal") into its parts. */
function splitKey(key) {
  const parts = key.split(":");
  const tag = parts.pop();
  const group0 = parts[0] || "";
  const group1 = parts[1] || parts[0] || "";
  return { group0, group1, tag };
}

module.exports = { ExifTool, splitKey, cleanError, COMMON_ARGS };
