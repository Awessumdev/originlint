import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
const base = `${homedir()}/.cache/puppeteer/chrome`;
export const CHROME = process.env.CHROME_PATH ||
  `${base}/${readdirSync(base).sort().pop()}/chrome-linux64/chrome`;
