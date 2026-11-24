const fs = require('fs');
const path = require('path');

const STALE_LOCK_FILES = [
  'lockfile',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverPersistedSessions(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];

  try {
    return fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => (
        entry.isDirectory()
        && entry.name.startsWith('session-')
        && entry.name.length > 'session-'.length
      ))
      .map((entry) => entry.name.slice('session-'.length))
      .sort();
  } catch (_) {
    return [];
  }
}

function sessionDirFor(sessionDir, sessionId) {
  return path.join(sessionDir, `session-${sessionId}`);
}

function clearStaleLocks(authDir) {
  if (!authDir || !fs.existsSync(authDir)) return;

  for (const name of STALE_LOCK_FILES) {
    const filePath = path.join(authDir, name);
    try {
      // Chromium's Singleton* entries are symlinks to "<hostname>-<pid>"; after a
      // container rebuild they dangle, so existsSync() returns false. Use lstat.
      fs.lstatSync(filePath);
      fs.rmSync(filePath, { force: true });
    } catch (_) {
      /* Chrome may still hold the file; boot will retry */
    }
  }
}

function removeDirSafe(dir) {
  if (!dir || !fs.existsSync(dir)) return false;

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return true;
}

module.exports = {
  discoverPersistedSessions,
  sessionDirFor,
  clearStaleLocks,
  removeDirSafe,
  sleep,
};
