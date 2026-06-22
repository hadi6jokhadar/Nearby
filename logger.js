// logger.js — shared file logger for the main process.
// Call setLogPath() once after app.getPath is available, then use log() anywhere.

const fs = require('fs');

let logPath = null;

function setLogPath(filePath) {
  logPath = filePath;
  try {
    fs.writeFileSync(logPath,
      `=== Nearby session started ${new Date().toISOString()} ===\n`
    );
  } catch {}
}

function log(context, ...args) {
  const parts = args.map((a) =>
    a instanceof Error ? a.stack || a.message
      : typeof a === 'object' ? JSON.stringify(a)
      : String(a)
  );
  const line = `[${new Date().toISOString()}] [${context}] ${parts.join(' ')}\n`;

  process.stdout.write(line);
  if (logPath) {
    try { fs.appendFileSync(logPath, line); } catch {}
  }
}

module.exports = { log, setLogPath };
