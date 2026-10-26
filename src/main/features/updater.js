"use strict";

// Check for updates
//
// myFile is built on this Mac from a git checkout (bash install.sh). Updating
// means what you would type by hand:
//   git checkout main && git pull && bash install.sh
// The checking and pulling happen here while the app is open. The rebuild
// replaces myFile.app itself, so it is handed to a small script that waits for
// the app to quit, runs install.sh (which reopens the app) and tells you if
// it failed.

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { UserError } = require("../lib/util");

const BRANCH = "main";
const GIT_ENV = {
  ...process.env,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`,
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

function git(root, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message || "git failed").trim());
        e.killed = Boolean(err.killed);
        reject(e);
      } else resolve(stdout.trim());
    });
  });
}

function projectRoot(ctx) {
  const root = ctx.runtime.projectRoot;
  if (!root || !fs.existsSync(path.join(root, ".git"))) {
    throw new UserError("This copy of myFile wasn't set up from GitHub with install.sh, so it can't update itself.");
  }
  return root;
}

async function check(ctx) {
  const root = projectRoot(ctx);
  try {
    await git(root, ["fetch", "origin", BRANCH]);
  } catch (err) {
    throw new UserError(err.killed ? "GitHub didn't answer in time. Check your internet connection." : `Couldn't reach GitHub: ${err.message.split("\n")[0]}`);
  }
  const [current, branch, behind, log, dirty] = await Promise.all([
    git(root, ["log", "-1", "--format=%h %s"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-list", "--count", `HEAD..origin/${BRANCH}`]),
    git(root, ["log", "--format=%s", "-n", "30", `HEAD..origin/${BRANCH}`]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  return {
    current,
    branch,
    behind: Number(behind) || 0,
    commits: log ? log.split("\n") : [],
    dirty: dirty ? dirty.split("\n").slice(0, 5) : [],
    canRestart: Boolean(ctx.updater),
  };
}

async function apply(ctx, _payload, task) {
  if (!ctx.updater) throw new UserError("Updating only works in the installed myFile app.");
  const root = projectRoot(ctx);
  task.progress({ label: "Switching to the main version…" });
  try {
    await git(root, ["checkout", BRANCH]);
    task.progress({ label: "Downloading the update…" });
    await git(root, ["pull", "--ff-only", "origin", BRANCH], 180000);
  } catch (err) {
    throw new UserError(`The update couldn't be downloaded: ${err.message.split("\n").slice(0, 3).join(" ")}`);
  }
  const script = path.join(ctx.runtime.dataDir, "update.sh");
  const log = path.join(root, ".runtime", "update.log");
  fs.writeFileSync(
    script,
    `#!/bin/bash
# Written by myFile when you press "Update". Waits for the app to quit, rebuilds it, reopens it.
ROOT="$1"; PID="$2"; LOG="$3"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
cd "$ROOT" || exit 1
if bash install.sh >"$LOG" 2>&1; then exit 0; fi
osascript -e 'display dialog "myFile could not finish updating. Details are in .runtime/update.log inside the myFile folder." buttons {"OK"} with icon caution' >/dev/null 2>&1
[ -d "$ROOT/myFile.app" ] && open "$ROOT/myFile.app"
`,
    { mode: 0o755 },
  );
  const child = spawn("/bin/bash", [script, root, String(process.pid), log], { detached: true, stdio: "ignore", cwd: root });
  child.unref();
  ctx.updater.quitSoon();
  return { restarting: true };
}

module.exports = { check, apply };
