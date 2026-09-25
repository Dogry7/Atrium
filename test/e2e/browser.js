import fs from 'node:fs';
import { chromium } from 'playwright';

/** Launch Chromium: the preinstalled one if present, else Playwright's own. */
export async function launch() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter(Boolean);
  const executablePath = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  return chromium.launch({ executablePath, args: ['--no-sandbox'] });
}
