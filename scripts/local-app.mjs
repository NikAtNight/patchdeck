import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const script = fileURLToPath(import.meta.url);
const repository = dirname(dirname(script));
const target = join(repository, "src-tauri", "target", "local");
const lock = join(target, "session.json");
const logDirectory = join(homedir(), "Library", "Logs", "Patchdeck Local");
const appPath = "/Applications/Patchdeck Local.app";
const launcherId = "com.local.patchdeck.launcher";
const action = process.argv[2] ?? "run";

// Finder does not inherit the interactive shell's executable search path.
const environment = {
  ...process.env,
  PATH: [dirname(process.execPath), join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":"),
  CARGO_TARGET_DIR: target,
};

function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: repository, env: environment, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}

function running() {
  if (!existsSync(lock)) return false;
  const { pid } = JSON.parse(readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid local session file: ${lock}`);
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("scripts/local-app.mjs run");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function supervise(child) {
  const stop = (signal) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    if (signal && signal !== "SIGINT" && signal !== "SIGTERM") console.error(`Local process exited with ${signal}.`);
    process.exitCode = code ?? (signal === "SIGINT" ? 0 : 1);
  });
}

try {
  if (process.platform !== "darwin") throw new Error("Patchdeck Local's app launcher requires macOS.");
  if (action === "install") {
    const staging = mkdtempSync("/Applications/.patchdeck-local-");
    const stagedApp = join(staging, "Patchdeck Local.app");
    const launchCommand = [process.execPath, script, "launch"].map(shellQuote).join(" ");
    const appleScript = `do shell script ${JSON.stringify(launchCommand)}`;
    command("/usr/bin/osacompile", ["-o", stagedApp, "-e", appleScript]);
    const plistPath = join(stagedApp, "Contents", "Info.plist");
    const plist = JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]));
    for (const key of Object.keys(plist)) {
      if (key.endsWith("UsageDescription")) delete plist[key];
    }
    plist.CFBundleIdentifier = launcherId;
    plist.CFBundleName = "Patchdeck Local";
    plist.LSUIElement = true;
    delete plist.CFBundleIconName;
    writeFileSync(plistPath, JSON.stringify(plist));
    command("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
    command("/bin/cp", [join(repository, "src-tauri", "icons", "icon.icns"), join(stagedApp, "Contents", "Resources", "applet.icns")]);
    command("/usr/bin/codesign", ["--force", "--sign", "-", stagedApp]);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
    if (existsSync(appPath)) {
      const identity = command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(appPath, "Contents", "Info.plist")]);
      if (identity !== launcherId) throw new Error(`${appPath} is not a Patchdeck Local launcher. Move it before installing.`);
      const backup = `${appPath}.backup-${Date.now()}`;
      renameSync(appPath, backup);
      console.log(`Previous launcher saved at ${backup}`);
    }
    renameSync(stagedApp, appPath);
    rmdirSync(staging);
    console.log(`Installed ${appPath}. Open it to start live development from ${repository}.`);
  } else if (action === "launch") {
    if (running()) {
      const count = command("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); String($.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.local.patchdeck.dev').count)"]);
      if (Number(count) > 0) command("/usr/bin/open", [join(target, "Patchdeck Local.app")]);
      console.log("Patchdeck Local is already running.");
    } else {
      mkdirSync(logDirectory, { recursive: true });
      const output = openSync(join(logDirectory, "development.log"), "a");
      const child = spawn(process.execPath, [script, "run"], {
        cwd: repository, env: environment, detached: true, stdio: ["ignore", output, output],
      });
      child.unref();
      console.log("Starting Patchdeck Local.");
    }
  } else if (action === "bundle") {
    // Cargo invokes this runner after each rebuild. Running inside a bundle gives
    // the live process its own Dock name, icon, and macOS application identity.
    const bundle = join(target, "Patchdeck Local.app");
    const contents = join(bundle, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    const executable = join(contents, "MacOS", "patchdeck");
    copyFileSync(process.argv[3], `${executable}.next`);
    renameSync(`${executable}.next`, executable);
    copyFileSync(join(repository, "src-tauri", "icons", "icon.icns"), join(contents, "Resources", "icon.icns"));
    const config = JSON.parse(readFileSync(join(repository, "src-tauri", "tauri.dev.conf.json"), "utf8"));
    const version = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).version;
    const plist = join(contents, "Info.plist");
    writeFileSync(plist, JSON.stringify({
      CFBundleName: config.productName, CFBundleDisplayName: config.productName,
      CFBundleIdentifier: config.identifier, CFBundleExecutable: "patchdeck",
      CFBundlePackageType: "APPL", CFBundleIconFile: "icon.icns",
      CFBundleShortVersionString: version, CFBundleVersion: version,
      NSHighResolutionCapable: true,
    }));
    command("/usr/bin/plutil", ["-convert", "xml1", plist]);
    command("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
  } else if (action === "run") {
    if (running()) throw new Error("Patchdeck Local is already running. Select its window in the Dock.");
    if (!existsSync(join(repository, "node_modules", ".bin", "tauri"))) throw new Error("Run npm ci in the repository before starting Patchdeck Local.");
    mkdirSync(target, { recursive: true });
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`A local session is starting or left a stale lock at ${lock}. If no Patchdeck Local session is running, remove that file and retry.`);
      throw error;
    }
    process.on("exit", () => {
      if (existsSync(lock) && JSON.parse(readFileSync(lock, "utf8")).pid === process.pid) unlinkSync(lock);
    });
    const host = command("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1];
    if (!host) throw new Error("Could not determine the Rust host target.");
    const runner = `target.${host}.runner=${JSON.stringify(["/bin/sh", join(repository, "scripts", "local-runner.sh")])}`;
    const child = spawn(join(repository, "node_modules", ".bin", "tauri"), ["dev", "--config", "src-tauri/tauri.dev.conf.json", "--", "--config", runner], {
      cwd: repository, env: environment, detached: true, stdio: "inherit",
    });
    supervise(child);
  } else {
    throw new Error("Usage: node scripts/local-app.mjs [run|install|launch]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
