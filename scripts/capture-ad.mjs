#!/usr/bin/env node
// Capture an ad creative from a URL — either downloads the image directly
// or takes a Playwright screenshot if it's a webpage.
// Usage: node capture-ad.mjs <url> <output-path>
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import https from 'https';
import http from 'http';

const url = process.argv[2];
const outPath = resolve(process.argv[3] || 'ad-creative.png');
mkdirSync(dirname(outPath), { recursive: true });

if (!url) {
  console.error('Usage: node capture-ad.mjs <url> <output-path>');
  process.exit(1);
}

// Step 1: HEAD request to check content type
console.log(`Checking ${url}...`);
const contentType = await getContentType(url);
console.log(`Content-Type: ${contentType}`);

if (contentType && contentType.startsWith('image/')) {
  // Direct image — download it
  console.log('Direct image detected — downloading...');
  const buf = await downloadBuffer(url);
  writeFileSync(outPath, buf);
  console.log(`Saved: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`);
} else {
  // Webpage — screenshot with Playwright
  console.log('Webpage detected — taking screenshot...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
    // Some pages never hit networkidle, fall back to domcontentloaded
    return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  });

  // Wait for content to render
  await page.waitForTimeout(3000);

  // Dismiss cookie banners / popups that might obscure the ad
  await page.evaluate(() => {
    // Common cookie banner selectors
    const selectors = [
      '[class*="cookie"] button', '[class*="consent"] button',
      '[id*="cookie"] button', '[id*="consent"] button',
      '[class*="banner"] button[class*="accept"]',
      '[class*="banner"] button[class*="close"]',
      'button[aria-label="Close"]', 'button[aria-label="Accept"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); break; }
    }
  });

  await page.waitForTimeout(1000);

  // Take viewport screenshot (not full page — we want what you'd see)
  await page.screenshot({ path: outPath, type: 'png' });
  console.log(`Screenshot saved: ${outPath}`);

  await browser.close();
}

// ─── Helpers ───

function getContentType(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(getContentType(res.headers.location));
      } else {
        resolve(res.headers['content-type'] || '');
      }
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadBuffer(res.headers.location));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
