"use strict";

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function log(level, ...args) {
  const line = `[${ts()}] [${level}]`;
  if (level === "ERROR") console.error(line, ...args);
  else console.log(line, ...args);
}

module.exports = {
  info: (...a) => log("INFO", ...a),
  warn: (...a) => log("WARN", ...a),
  error: (...a) => log("ERROR", ...a),
  step: (...a) => log("STEP", ...a),
};
