#!/usr/bin/env node
// Never place bearer tokens in command-line arguments or print response credentials.
import { readFile } from 'node:fs/promises';
const [action, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!['status', 'seed', 'refresh', 'poll', 'test-email', 'verify-fallback'].includes(action)) {
  throw new Error('Usage: aqi-admin.mjs status|seed|refresh|poll|test-email|verify-fallback --key-file PATH [--token-file PATH]');
}
const keyFile = option('--key-file');
const key = keyFile ? (await readFile(keyFile, 'utf8')).trim() : process.env.AQI_ADMIN_KEY;
if (!key) throw new Error('Provide AQI_ADMIN_KEY or --key-file');
let body;
if (action === 'seed') {
  const tokenFile = option('--token-file');
  if (!tokenFile) throw new Error('seed requires --token-file pointing to a private JSON file containing {"token":"..."}');
  const data = JSON.parse(await readFile(tokenFile, 'utf8'));
  if (typeof data.token !== 'string') throw new Error('Token file has no token');
  body = JSON.stringify({ token: data.token });
}
const response = await fetch(`https://aqi-backend.murali.page/internal/aqi/${action === 'seed' ? 'session' : action}`, {
  method: action === 'status' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
});
const text = await response.text();
// Defense in depth: redact JWT-shaped strings even if a server regression returns a credential.
console.log(text.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, match => match.startsWith('eyJ') ? '[REDACTED]' : match));
if (!response.ok) process.exitCode = 1;
