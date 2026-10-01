const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const logger = require('../logger');
const { httpError } = require('../errors');
const {
  discoverPersistedSessions,
  sessionDirFor,
  clearStaleLocks,
  removeDirSafe,
  sleep,
} = require('./sessionStore');
const {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  ensureProcessGone,
  findSessionProcessPids,
} = require('./browserProcess');

const REUSABLE_STATUSES = new Set(['initializing', 'qr', 'authenticated', 'ready']);
const SETTLED_STATUSES = new Set(['qr', 'ready', 'error', 'auth_failure']);
const DEAD_STATUSES = new Set(['error', 'disconnected', 'auth_failure']);
const INIT_TIMEOUT_MS = 90000;
const AUTH_STUCK_MS = 120000;

// Retry backoff: 5s, 10s, 20s, 40s, 60s (capped), +/-20% jitter.
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_LOGOUT_BASE_DELAY_MS = 2500;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 5;

const BROWSER_CLOSE_TIMEOUT_MS = 15000;
const PID_CAPTURE_TIMEOUT_MS = 20000;
const PID_CAPTURE_POLL_MS = 200;

function nowIso() {
  return new Date().toISOString();
}

function classifyInitError(message = '') {
  const msg = String(message);
  if (/already running for/i.test(msg)) return 'browser_already_running';
  if (/Failed to launch the browser process|Failed to launch/i.test(msg)) return 'browser_launch_failed';
  if (/net::ERR_|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/i.test(msg)) return 'network_error';
  if (/Target closed|Session closed|Protocol error|Execution context was destroyed|Connection closed/i.test(msg)) return 'browser_crashed';
  if (/Unexpected token|Unexpected end of JSON|ENOENT.*(Preferences|Local State)/i.test(msg)) return 'session_corruption';
  return 'unknown';
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.shuttingDown = false;
    this.reconnectTimers = new Map();
    this.reconnectCounts = new Map();
    // Per-sessionId promise chains so boot/stop/destroy never overlap for the same session.
    this.sessionLocks = new Map();
    // Per-sessionId in-flight cleanup, so cleanupSession() is safe to call more than once.
    this.cleanupPromises = new Map();
  }

  list() {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      status: session.status,
    }));
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw httpError('Session not found', 404, 'session_not_found');
    return session;
  }

  requireReady(sessionId) {
    const session = this.get(sessionId);
    if (session.status !== 'ready') {
      throw httpError(`Session not ready (status: ${session.status})`, 409, 'session_not_ready');
    }
    return session;
  }

  isReusable(session) {
    if (!session || DEAD_STATUSES.has(session.status)) return false;
    if (!REUSABLE_STATUSES.has(session.status)) return false;

    const age = Date.now() - (session.startedAt || 0);
    if (session.status === 'initializing' && age > INIT_TIMEOUT_MS) return false;
    if (session.status === 'authenticated' && !session.readyAt && age > AUTH_STUCK_MS) return false;
    return true;
  }

  /**
   * Serializes every lifecycle operation (boot/stop/destroy) for a given sessionId so
   * two initializations (or an initialize racing a stop) can never run concurrently
   * against the same persistent userDataDir.
   */
  withSessionLock(sessionId, fn) {
    const previous = this.sessionLocks.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    this.sessionLocks.set(sessionId, run);
    const clear = () => {
      if (this.sessionLocks.get(sessionId) === run) {
        this.sessionLocks.delete(sessionId);
      }
    };
    run.then(clear, clear);
    return run;
  }

  boot(sessionId, opts = {}) {
    return this.withSessionLock(sessionId, () => this._boot(sessionId, opts));
  }

  async _boot(sessionId, { force = false } = {}) {
    if (this.shuttingDown) {
      throw httpError('Server is shutting down', 503, 'shutting_down');
    }

    const existing = this.sessions.get(sessionId);
    if (!force && this.isReusable(existing)) {
      return existing;
    }

    this.clearReconnect(sessionId);

    if (existing) {
      this.sessions.delete(sessionId);
      await this.cleanupSession(sessionId, existing, 'reinitialize');
    } else {
      // Fresh in-memory state (first boot after process start/crash restart by NSSM) does
      // NOT mean the browser is gone: a previous Node process may have died without a
      // graceful shutdown while Chrome kept running. Check for and clean up any orphan.
      await this.reconcileOrphan(sessionId);
    }

    if (!config.chromePath && (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH)) {
      logger.warn('configured Chrome path not found, falling back to Puppeteer bundled Chromium');
    }

    const attempt = (this.reconnectCounts.get(sessionId) || 0) + 1;
    logger.info('SESSION_INIT_START', { sessionId, attempt, reason: force ? 'restart' : 'boot', timestamp: nowIso() });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: config.sessionDir,
        rmMaxRetries: 8,
      }),
      authTimeoutMs: 60000,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 5000,
      webVersionCache: { type: 'local' },
      puppeteer: {
        headless: true,
        ...(config.chromePath ? { executablePath: config.chromePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    const session = {
      client,
      status: 'initializing',
      qrDataUri: null,
      readyAt: null,
      startedAt: Date.now(),
      pid: null,
    };

    this.sessions.set(sessionId, session);
    this.bindEvents(sessionId, session, client);

    logger.info('BROWSER_LAUNCH_START', { sessionId, attempt, timestamp: nowIso() });
    this.captureBrowserPid(sessionId, session, client);

    client.initialize().catch((error) => {
      this.handleFailure(sessionId, session, error.message);
    });

    return session;
  }

  /**
   * Watches for the underlying Puppeteer browser process to appear and records its pid
   * (in memory + on disk) as soon as it's known, so cleanup can find and verify it even
   * if this Node process crashes/restarts before a graceful shutdown runs.
   */
  async captureBrowserPid(sessionId, session, client) {
    const authDir = sessionDirFor(config.sessionDir, sessionId);
    const deadline = Date.now() + PID_CAPTURE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.sessions.get(sessionId) !== session) return;

      let proc = null;
      try {
        proc = client.pupBrowser?.process?.() || null;
      } catch (_) {
        proc = null;
      }

      if (proc?.pid) {
        session.pid = proc.pid;
        writePidFile(authDir, proc.pid);
        logger.info('BROWSER_LAUNCH_SUCCESS', { sessionId, pid: proc.pid, timestamp: nowIso() });
        return;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(PID_CAPTURE_POLL_MS);
    }

    if (this.sessions.get(sessionId) === session && !session.pid) {
      logger.warn('BROWSER_LAUNCH_FAILED', { sessionId, reason: 'no browser process observed', timestamp: nowIso() });
    }
  }

  async waitForBoot(sessionId, timeoutMs = 45000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const session = this.sessions.get(sessionId);
      if (!session) throw httpError('Session not found', 404, 'session_not_found');

      if (session.qrDataUri || SETTLED_STATUSES.has(session.status)) {
        if (session.status === 'qr' && !session.qrDataUri) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(250);
          continue;
        }
        return session;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }

    return this.get(sessionId);
  }

  bindEvents(sessionId, session, client) {
    client.on('loading_screen', (percent, message) => {
      logger.info('session loading', { sessionId, percent, message });
    });

    client.on('qr', async (qr) => {
      try {
        session.qrDataUri = await qrcode.toDataURL(qr);
        session.status = 'qr';
        logger.info('session qr ready', { sessionId });
      } catch (error) {
        logger.error('failed to render qr', { sessionId, message: error.message });
      }
    });

    client.on('authenticated', () => {
      session.status = 'authenticated';
      session.readyAt = null;
      logger.info('session authenticated', { sessionId });
    });

    client.on('change_state', (state) => {
      logger.info('session state', { sessionId, state });
    });

    client.on('auth_failure', (message) => {
      // A real WhatsApp-side auth rejection - not a transient error. Clean up the
      // browser but do not schedule an automatic retry: retrying immediately with the
      // same invalid session would just repeat the failure.
      if (this.sessions.get(sessionId) !== session) return;
      session.status = 'auth_failure';
      session.readyAt = null;
      logger.error('auth failure', { sessionId, message });
      this.handleFailure(sessionId, session, 'auth_failure', { retry: false });
    });

    client.on('ready', () => {
      session.status = 'ready';
      session.readyAt = Date.now();
      session.qrDataUri = null;
      this.reconnectCounts.delete(sessionId);
      logger.info('SESSION_INIT_SUCCESS', { sessionId, timestamp: nowIso() });
    });

    client.on('disconnected', (reason) => {
      if (this.shuttingDown) return;
      if (this.sessions.get(sessionId) !== session) return;

      session.status = 'disconnected';
      session.readyAt = null;
      session.qrDataUri = null;
      logger.warn('session disconnected', { sessionId, reason });
      this.handleFailure(sessionId, session, String(reason || 'disconnected'));
    });
  }

  /**
   * Common failure path for initialize() rejections, unexpected disconnects, and auth
   * failures: classify the error, log it, clean up the browser/process, and only then
   * (optionally) schedule a backed-off retry. Retry NEVER starts before cleanup settles.
   */
  async handleFailure(sessionId, session, rawReason, { retry = true } = {}) {
    if (this.sessions.get(sessionId) !== session) return;

    const reason = classifyInitError(rawReason);
    const attempt = (this.reconnectCounts.get(sessionId) || 0) + 1;

    session.status = 'error';
    logger.error('SESSION_INIT_FAILED', {
      sessionId,
      attempt,
      reason,
      message: rawReason,
      timestamp: nowIso(),
    });

    try {
      await this.cleanupSession(sessionId, session, reason);
    } catch (error) {
      logger.error('SESSION_CLEANUP_FAILED', { sessionId, reason, message: error.message, timestamp: nowIso() });
    }

    if (retry && !this.shuttingDown) {
      this.scheduleReconnect(sessionId, reason);
    }
  }

  clearReconnect(sessionId) {
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }
  }

  scheduleReconnect(sessionId, reason) {
    if (this.shuttingDown) return;
    if (this.reconnectTimers.has(sessionId)) return;

    const count = (this.reconnectCounts.get(sessionId) || 0) + 1;
    if (count > RECONNECT_MAX_ATTEMPTS) {
      logger.error('session restart gave up', { sessionId, reason, attempt: count, timestamp: nowIso() });
      this.reconnectCounts.delete(sessionId);
      return;
    }
    this.reconnectCounts.set(sessionId, count);

    const isLogout = String(reason).toUpperCase().includes('LOGOUT');
    const base = isLogout ? RECONNECT_LOGOUT_BASE_DELAY_MS : RECONNECT_BASE_DELAY_MS;
    const exponential = Math.min(base * (2 ** (count - 1)), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.floor(exponential * 0.2 * Math.random());
    const delay = exponential + jitter;

    logger.info('SESSION_RETRY_SCHEDULED', {
      sessionId, reason, attempt: count, delayMs: delay, timestamp: nowIso(),
    });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      if (this.shuttingDown) return;

      this.boot(sessionId, { force: true }).catch((error) => {
        logger.error('session restart failed', { sessionId, message: error.message });
      });
    }, delay);
    timer.unref?.();

    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Idempotent browser/session cleanup. Safe to call more than once (or concurrently) for
   * the same sessionId - concurrent callers share the same in-flight promise. Never trusts
   * `client.pupBrowser` going null/disconnected as proof the OS process exited; it verifies
   * and, if needed, force-terminates the specific pid before returning.
   */
  cleanupSession(sessionId, session, reason = 'unknown') {
    const existing = this.cleanupPromises.get(sessionId);
    if (existing) return existing;

    const promise = this._cleanupSession(sessionId, session, reason).finally(() => {
      if (this.cleanupPromises.get(sessionId) === promise) {
        this.cleanupPromises.delete(sessionId);
      }
    });

    this.cleanupPromises.set(sessionId, promise);
    return promise;
  }

  async _cleanupSession(sessionId, session, reason) {
    const authDir = sessionDirFor(config.sessionDir, sessionId);
    const startedAt = Date.now();
    logger.info('SESSION_CLEANUP_START', { sessionId, reason, timestamp: nowIso() });

    try {
      const client = session?.client;

      let pid = session?.pid || null;
      try {
        const proc = client?.pupBrowser?.process?.();
        if (proc?.pid) pid = proc.pid;
      } catch (_) {
        /* ignore */
      }

      if (client) {
        logger.info('BROWSER_CLOSE_START', { sessionId, reason, timestamp: nowIso() });
        try {
          await withTimeout(client.destroy(), BROWSER_CLOSE_TIMEOUT_MS, 'client.destroy timed out');
          logger.info('BROWSER_CLOSE_SUCCESS', { sessionId, reason, timestamp: nowIso() });
        } catch (error) {
          logger.error('BROWSER_CLOSE_FAILED', { sessionId, reason, message: error.message, timestamp: nowIso() });
        }
      }

      const pidsToVerify = new Set();
      if (pid) pidsToVerify.add(pid);
      const filePid = readPidFile(authDir);
      if (filePid) pidsToVerify.add(filePid);

      // Neither of the above catches the case where the Browser object itself never
      // got created (pupBrowser.process() never resolved a pid) but a real chrome.exe
      // still spawned and is holding the profile's Windows process-singleton - that's
      // exactly what produces an endless "already running" retry loop. Find it by
      // command line instead of relying on a pid we never captured.
      const orphanPids = await findSessionProcessPids(authDir);
      for (const orphanPid of orphanPids) pidsToVerify.add(orphanPid);

      for (const candidatePid of pidsToVerify) {
        // eslint-disable-next-line no-await-in-loop
        await ensureProcessGone(candidatePid, authDir, { sessionId });
      }

      removePidFile(authDir);
      clearStaleLocks(authDir);

      logger.info('SESSION_CLEANUP_SUCCESS', {
        sessionId, reason, durationMs: Date.now() - startedAt, timestamp: nowIso(),
      });
    } catch (error) {
      logger.error('SESSION_CLEANUP_FAILED', { sessionId, reason, message: error.message, timestamp: nowIso() });
      throw error;
    }
  }

  /**
   * Handles the case where this Node process has no in-memory session (fresh start, or
   * NSSM restarted us after a crash) but a browser from a previous run may still be
   * holding the persistent userDataDir lock.
   */
  async reconcileOrphan(sessionId) {
    const authDir = sessionDirFor(config.sessionDir, sessionId);

    const pids = new Set();
    const filePid = readPidFile(authDir);
    if (filePid) pids.add(filePid);
    const scannedPids = await findSessionProcessPids(authDir);
    for (const scannedPid of scannedPids) pids.add(scannedPid);

    for (const pid of pids) {
      if (!isProcessAlive(pid)) continue;
      logger.warn('found orphaned browser process from previous run', { sessionId, pid, authDir, timestamp: nowIso() });
      // eslint-disable-next-line no-await-in-loop
      await ensureProcessGone(pid, authDir, { sessionId });
    }

    removePidFile(authDir);
    clearStaleLocks(authDir);
  }

  stop(sessionId, opts = {}) {
    return this.withSessionLock(sessionId, () => this._stop(sessionId, opts));
  }

  async _stop(sessionId, { clearReconnect = true } = {}) {
    if (clearReconnect) this.clearReconnect(sessionId);

    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.reconcileOrphan(sessionId);
      return;
    }

    this.sessions.delete(sessionId);
    await this.cleanupSession(sessionId, session, 'stop_requested');
  }

  destroy(sessionId) {
    return this.withSessionLock(sessionId, () => this._destroy(sessionId));
  }

  async _destroy(sessionId) {
    this.clearReconnect(sessionId);

    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) {
      await this.cleanupSession(sessionId, session, 'destroy_requested');
    } else {
      await this.reconcileOrphan(sessionId);
    }

    const authDir = sessionDirFor(config.sessionDir, sessionId);
    try {
      removeDirSafe(authDir);
    } catch (error) {
      logger.error('failed to remove session folder', { sessionId, code: error.code, message: error.message });
      throw httpError(`Failed to reset session files: ${error.message}`, 503, 'session_reset_failed');
    }
  }

  async autoStartPersistedSessions() {
    if (!config.autoStartSessions) return;

    const sessionIds = new Set(discoverPersistedSessions(config.sessionDir));
    if (config.defaultSession) sessionIds.add(config.defaultSession);

    for (const sessionId of sessionIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.boot(sessionId);
        logger.info('auto-started persisted session', { sessionId });
      } catch (error) {
        logger.error('failed to auto-start persisted session', {
          sessionId,
          message: error.message,
        });
      }
    }
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info('SESSION_SHUTDOWN_START', { timestamp: nowIso() });

    for (const sessionId of this.reconnectTimers.keys()) {
      this.clearReconnect(sessionId);
    }

    const sessionIds = [...this.sessions.keys()];
    await Promise.all(
      sessionIds.map((sessionId) => this
        .withSessionLock(sessionId, async () => {
          const session = this.sessions.get(sessionId);
          if (!session) return;
          this.sessions.delete(sessionId);
          try {
            await this.cleanupSession(sessionId, session, 'shutdown');
          } catch (error) {
            logger.error('SESSION_CLEANUP_FAILED', { sessionId, reason: 'shutdown', message: error.message });
          }
        })),
    );

    this.sessions.clear();
    logger.info('SESSION_SHUTDOWN_COMPLETE', { timestamp: nowIso() });
  }
}

module.exports = new SessionManager();
