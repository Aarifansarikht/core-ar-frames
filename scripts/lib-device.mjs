// Shared helpers for driving Android Chrome on a USB-attached phone over adb + CDP.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

export const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();

/** Maps the phone's localhost:<port> to this machine (a secure context, so no certificate is needed). */
export function reversePort(port) {
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
}

/** Opens a CDP connection to the phone's Chrome. Starts Chrome if it isn't running. */
export async function connectPhoneChrome(cdpPort = 9333) {
  adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
  await new Promise((r) => setTimeout(r, 1500));
  adb('forward', `tcp:${cdpPort}`, 'localabstract:chrome_devtools_remote');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return { browser, context: browser.contexts()[0] };
}
