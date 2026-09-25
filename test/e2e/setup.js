import { launch } from './browser.js';
import { startApp } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';

process.env.ATRIUM_SIM_FAST = '0'; // real pacing so animations and streaming are exercised

export const SHOTS = process.env.ATRIUM_SHOTS || path.join(process.cwd(), 'test-results');

/** One browser page on a fresh Atrium, with console-error capture. */
export async function session({ viewport = { width: 1440, height: 900 }, app } = {}) {
  const t = app || await startApp();
  const browser = await launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.setDefaultTimeout(15000);
  fs.mkdirSync(SHOTS, { recursive: true });
  return {
    t, page, browser, errors,
    shot: (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }),
    open: async (hash = '') => { await page.goto(`${t.base}/${hash}`); await page.waitForSelector('.rail'); await page.waitForFunction(() => !document.querySelector('.page .spinner')); },
    close: async () => { await browser.close(); if (!app) await t.close(); },
  };
}
