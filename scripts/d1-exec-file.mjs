#!/usr/bin/env node
/**
 * Runs SQL files against production D1 over the HTTP API, a few dozen statements
 * per request, retrying when D1 is busy. Replaces `wrangler d1 execute --file`,
 * which imports the file as one job: the database stops serving the site while it
 * runs, and the job fails outright ("D1 DB is overloaded") when D1 is busy.
 *
 * Usage: node scripts/d1-exec-file.mjs file.sql [more.sql ...]
 * Logs are public: counts only.
 */
import { readFileSync } from 'node:fs';
import { d1 as d1FromEnv } from './lib/d1.mjs';

/** Splits SQL into statements on semicolons outside string literals; drops -- comments. */
export function splitSql(text) {
  const out = [];
  let cur = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = false; // '' (an escaped quote) re-enters on the next char
    } else if (ch === "'") {
      cur += ch; inStr = true;
    } else if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      cur += '\n';
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Groups statements into requests of at most maxStatements / maxChars. */
export function batches(statements, maxStatements = 40, maxChars = 300000) {
  const out = [];
  let cur = [], size = 0;
  for (const s of statements) {
    if (cur.length && (cur.length >= maxStatements || size + s.length > maxChars)) { out.push(cur); cur = []; size = 0; }
    cur.push(s); size += s.length + 2;
  }
  if (cur.length) out.push(cur);
  return out;
}

const RETRYABLE = /overloaded|queued for too long|too many requests|429|50[0-9]|timeout|network|fetch failed/i;

export async function execStatements(statements, { d1 = d1FromEnv, log = console.log, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const parts = batches(statements);
  let done = 0;
  for (const part of parts) {
    for (let attempt = 1; ; attempt++) {
      try {
        await d1(part.join(';\n') + ';');
        break;
      } catch (e) {
        if (attempt >= 5 || !RETRYABLE.test(e.message)) throw new Error(`statements ${done + 1}-${done + part.length}: ${e.message}`);
        log(`  D1 busy (${e.message.slice(0, 80)}); retry ${attempt} in ${2 ** attempt}s`);
        await sleep(2000 * 2 ** (attempt - 1));
      }
    }
    done += part.length;
  }
  return { statements: done, requests: parts.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: d1-exec-file.mjs file.sql [more.sql ...]'); process.exit(2); }
  (async () => {
    for (const f of files) {
      const statements = splitSql(readFileSync(f, 'utf8'));
      if (!statements.length) { console.log(`${f}: empty`); continue; }
      const r = await execStatements(statements);
      console.log(`${f}: ${r.statements} statements in ${r.requests} requests`);
    }
  })().catch(e => { console.error(`d1-exec-file failed: ${e.message}`); process.exit(1); });
}
