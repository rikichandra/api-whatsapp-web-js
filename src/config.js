const fs = require('fs');
const path = require('path');

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function existingFile(filePath) {
  if (!filePath) return undefined;
  try {
    return fs.existsSync(filePath) ? filePath : undefined;
  } catch (_) {
    return undefined;
  }
}

function firstExisting(paths) {
  for (const filePath of paths) {
    const found = existingFile(filePath);
    if (found) return found;
  }
  return undefined;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

module.exports = {
  nodeEnv,
  isProduction,
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3000', 10),
  token: String(process.env.SERVICE_TOKEN || process.env.API_TOKEN || process.env.SIDECAR_TOKEN || '').trim(),
  defaultSession: process.env.DEFAULT_SESSION || 'main',
  sessionDir: process.env.SESSION_DIR || path.join(process.cwd(), 'sessions'),
  pidFile: process.env.PID_FILE || process.env.SIDECAR_PID_FILE || '',
  autoStartSessions: envBool(process.env.AUTO_START_SESSIONS, true),
  chromePath: firstExisting([
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]),
  bodyLimit: process.env.BODY_LIMIT || '50mb',
  debugBrowser: envBool(process.env.DEBUG_BROWSER, false),
  // Pinned WA Web bundle version — see .env.example for why this exists.
  webVersion: process.env.WEB_VERSION || '2.3000.1046959651',
};
