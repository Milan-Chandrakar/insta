import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { config } from '../config.js';

let initialized = false;
let stream = null;

function formatLine(level, args) {
  const message = util.format(...args);
  return `[${new Date().toISOString()}] ${level} ${message}\n`;
}

function writeLine(level, args) {
  if (!stream) {
    return;
  }

  stream.write(formatLine(level, args));
}

export function getRuntimeLogFile() {
  return config.runtimeLogFile;
}

export function initRuntimeLogger() {
  if (initialized) {
    return config.runtimeLogFile;
  }

  fs.mkdirSync(path.dirname(config.runtimeLogFile), { recursive: true });
  stream = fs.createWriteStream(config.runtimeLogFile, { flags: 'w' });

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  console.log = (...args) => {
    writeLine('INFO', args);
    original.log(...args);
  };

  console.info = (...args) => {
    writeLine('INFO', args);
    original.info(...args);
  };

  console.warn = (...args) => {
    writeLine('WARN', args);
    original.warn(...args);
  };

  console.error = (...args) => {
    writeLine('ERROR', args);
    original.error(...args);
  };

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  initialized = true;
  console.log(`Runtime log file: ${config.runtimeLogFile}`);
  return config.runtimeLogFile;
}
