"use strict";

// Check for updates
//
// myFile is built on this Mac from a git checkout (bash install.sh). Updating
// means what you would type by hand:
//   fetch origin/main, safely sync main, then bash install.sh
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
  const [current, branch, behind, log, dirty, ahead] = await Promise.all([
    git(root, ["log", "-1", "--format=%h %s"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-list", "--count", `HEAD..origin/${BRANCH}`]),
    git(root, ["log", "--format=%s", "-n", "30", `HEAD..origin/${BRANCH}`]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    git(root, ["rev-list", "--count", `origin/${BRANCH}..HEAD`]),
  ]);
  return {
    current,
    branch,
    behind: Number(behind) || 0,
    ahead: Number(ahead) || 0,
    commits: log ? log.split("\n") : [],
    dirty: dirty ? dirty.split("\n").slice(0, 5) : [],
    canRestart: Boolean(ctx.updater),
  };
}

async function updateSource(ctx, task) {
  const root = projectRoot(ctx);
  try {
    // Never discard edits to the app's source. Local commits are preserved on
    // a recovery branch before syncing a rewritten upstream history.
    const dirty = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) throw new UserError("The myFile source has local edits. Commit or stash them before updating; your edits have been left untouched.");
    task.progress({ label: "Downloading the update…" });
    await git(root, ["fetch", "origin", BRANCH], 180000);
    task.progress({ label: "Switching to the main version…" });
    await git(root, ["checkout", BRANCH]);
    const target = await git(root, ["rev-parse", `origin/${BRANCH}`]);
    const local = Number(await git(root, ["rev-list", "--count", `${target}..HEAD`]));
    let backup = null;
    if (local) {
      const head = await git(root, ["rev-parse", "--short", "HEAD"]);
      backup = `myfile-before-update-${Date.now()}-${head}`;
      await git(root, ["branch", backup, "HEAD"]);
      // --keep also refuses to overwrite local/untracked files in the way.
      await git(root, ["reset", "--keep", target]);
    } else {
      await git(root, ["merge", "--ff-only", target]);
    }
    return { backup };
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`The update couldn't be downloaded: ${err.message.split("\n").slice(0, 3).join(" ")}`);
  }
}

async function apply(ctx, _payload, task) {
  if (!ctx.updater) throw new UserError("Updating only works in the installed myFile app.");
  const root = projectRoot(ctx);
  await updateSource(ctx, task);
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

module.exports = { check, apply, updateSource };
