const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent-office.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function write(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

module.exports = {
  info:  (msg) => write('INFO',  msg),
  error: (msg) => write('ERROR', msg),
  plan:  (msg) => write('PLAN',  msg),
  skill: (name, msg) => write('SKILL', `[${name}] ${msg}`),
};
