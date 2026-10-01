const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../logger');

const PID_FILE_NAME = '.browser.pid';
const VERIFY_TIMEOUT_MS = 5000;
const KILL_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidFilePath(authDir) {
  return path.join(authDir, PID_FILE_NAME);
}

function writePidFile(authDir, pid) {
  if (!authDir || !pid) return;
  try {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(pidFilePath(authDir), String(pid));
  } catch (error) {
    logger.warn('failed to persist browser pid file', { authDir, pid, message: error.message });
  }
}

function readPidFile(authDir) {
  try {
    const raw = fs.readFileSync(pidFilePath(authDir), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function removePidFile(authDir) {
  try {
    fs.rmSync(pidFilePath(authDir), { force: true });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Checks whether an OS process with the given pid still exists.
 * A `browser === null`/reference going away does NOT mean the OS process is gone,
 * so every cleanup path must go through this instead of trusting in-memory state.
 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it -> still alive.
    return error.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !isProcessAlive(pid);
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: VERIFY_TIMEOUT_MS, windowsHide: true, ...opts }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Confirms a pid actually belongs to a browser process for OUR userDataDir before
 * we force-kill it. This avoids ever touching an unrelated process that happens to
 * reuse a recycled pid, and avoids blanket `taskkill /IM chrome.exe`.
 */
async function pidBelongsToSession(pid, authDir) {
  if (process.platform !== 'win32') {
    // Best-effort only: without a reliable cross-platform command-line lookup,
    // stay conservative and refuse to force-kill.
    return false;
  }

  try {
    const stdout = await execFileP('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ]);
    const commandLine = String(stdout || '').trim();
    if (!commandLine) return false;
    const normalizedCmd = commandLine.toLowerCase();
    const normalizedDir = path.resolve(authDir).toLowerCase();
    return normalizedCmd.includes(normalizedDir);
  } catch (error) {
    logger.warn('failed to verify browser process ownership', { pid, authDir, message: error.message });
    return false;
  }
}

/**
 * Fallback discovery for when we have no tracked pid at all (e.g. the Browser object
 * creation itself threw before pupBrowser.process() ever resolved a pid): scans every
 * chrome.exe on the box and keeps only the ones whose command line references this
 * session's own userDataDir. This is how we find the orphaned process actually holding
 * the Windows process-singleton that causes "already running" launch failures.
 */
async function findSessionProcessPids(authDir) {
  if (process.platform !== 'win32') return [];

  try {
    const stdout = await execFileP('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
    ]);
    const raw = String(stdout || '').trim();
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const normalizedDir = path.resolve(authDir).toLowerCase();

    return rows
      .filter((row) => row && typeof row.CommandLine === 'string' && row.CommandLine.toLowerCase().includes(normalizedDir))
      .map((row) => row.ProcessId)
      .filter((candidatePid) => Number.isFinite(candidatePid) && candidatePid > 0);
  } catch (error) {
    logger.warn('failed to scan for orphaned browser processes', { authDir, message: error.message });
    return [];
  }
}

async function killProcessTree(pid) {
  if (process.platform === 'win32') {
    await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: KILL_TIMEOUT_MS })
      .catch((error) => {
        // "not found" just means it already exited; anything else is worth logging.
        if (!/not found/i.test(String(error.message))) {
          logger.warn('taskkill failed', { pid, message: error.message });
        }
      });
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    /* already gone */
  }
}

/**
 * Idempotent, safe attempt to make sure a specific browser process is actually gone.
 * Never kills by process name/image — only by a pid we captured ourselves or persisted
 * to disk, and only after verifying (on Windows) that its command line references the
 * session's own userDataDir.
 */
async function ensureProcessGone(pid, authDir, { sessionId, graceMs = 3000 } = {}) {
  if (!isProcessAlive(pid)) return true;

  const exitedGracefully = await waitForProcessExit(pid, graceMs);
  if (exitedGracefully) return true;

  const verified = await pidBelongsToSession(pid, authDir);
  if (!verified) {
    logger.warn('stale browser pid could not be verified against session userDataDir, leaving it alone', {
      sessionId,
      pid,
      authDir,
    });
    return false;
  }

  logger.warn('force terminating stale browser process for session', { sessionId, pid, authDir });
  await killProcessTree(pid);
  return waitForProcessExit(pid, graceMs);
}

module.exports = {
  pidFilePath,
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  waitForProcessExit,
  ensureProcessGone,
  findSessionProcessPids,
};
