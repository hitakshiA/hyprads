#!/usr/bin/env node
// Capture an ad creative from a URL.
// Strategy: Playwright first → Firecrawl fallback if login wall detected
// Both return: screenshot PNG + optional markdown content for richer analysis
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { execFileSync } from 'child_process';
import https from 'https';
import http from 'http';

const url = process.argv[2];
const outPath = resolve(process.argv[3] || 'ad-creative.png');
mkdirSync(dirname(outPath), { recursive: true });

if (!url) { console.error('Usage: node capture-ad.mjs <url> <output-path>'); process.exit(1); }

console.log(`Capturing: ${url}`);
const contentType = await getContentType(url);

if (contentType && contentType.startsWith('image/')) {
  console.log('Direct image — downloading...');
  const buf = await downloadBuffer(url);
  writeFileSync(outPath, buf);
  console.log(`Done: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`);
  process.exit(0);
}

// Try Playwright first (free, no API needed)
let success = await tryPlaywright(url, outPath);

// If Playwright got a login wall, try Firecrawl CLI
if (!success) {
  success = await tryFirecrawlCLI(url, outPath);
}

if (!success) {
  console.error('All methods failed for:', url);
  process.exit(1);
}

// ─── Playwright ───
async function tryPlaywright(url, outPath) {
  try {
    console.log('Playwright: loading...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    );
    await page.waitForTimeout(3000);

    // Dismiss cookie banners
    await page.evaluate(() => {
      for (const sel of ['[class*="cookie"] button','[class*="consent"] button','button[aria-label="Close"]','button[aria-label="Accept"]','button[aria-label="Accept all"]']) {
        try { const b = document.querySelector(sel); if (b) { b.click(); break; } } catch {}
      }
    });
    await page.waitForTimeout(1000);

    // Detect login walls
    const check = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const isWall =
        text.length < 200 ||
        (text.includes('log in') && text.includes('sign up') && text.length < 1000) ||
        text.includes("post isn't available") ||
        text.includes("this page doesn't exist") ||
        text.includes('create an account') ||
        text.includes('sorry, this page') ||
        text.includes('content isn\'t available');
      return { len: text.length, wall: isWall };
    });

    console.log(`Playwright: ${check.len} chars, wall: ${check.wall}`);

    if (check.wall) { await browser.close(); return false; }

    await page.screenshot({ path: outPath, type: 'png' });
    console.log(`Playwright OK: ${outPath}`);
    await browser.close();
    return true;
  } catch (e) {
    console.log('Playwright error:', e.message);
    return false;
  }
}

// ─── Firecrawl CLI ───
async function tryFirecrawlCLI(url, outPath) {
  // Check if firecrawl CLI is available
  try { execFileSync('which', ['firecrawl'], { stdio: 'pipe' }); } catch {
    console.log('Firecrawl CLI not installed, skipping');
    return false;
  }

  try {
    console.log('Firecrawl: screenshotting...');

    // Use firecrawl CLI with screenshot + markdown
    const result = execFileSync('firecrawl', [
      'scrape', url,
      '--screenshot',
      '--format', 'markdown',
      '--json',
      '--wait-for', '3000',
    ], { timeout: 45000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    const data = JSON.parse(result);

    // Get screenshot URL
    const screenshotUrl = data?.screenshot || data?.data?.screenshot;
    if (screenshotUrl) {
      console.log('Firecrawl: downloading screenshot...');
      const imgBuf = await downloadBuffer(screenshotUrl);
      writeFileSync(outPath, imgBuf);
      console.log(`Firecrawl screenshot: ${outPath} (${(imgBuf.length / 1024).toFixed(0)}KB)`);
    }

    // Save markdown content alongside for richer ad analysis
    const markdown = data?.markdown || data?.data?.markdown;
    if (markdown && markdown.length > 50) {
      const mdPath = outPath.replace(/\.png$/, '-content.md');
      writeFileSync(mdPath, markdown, 'utf8');
      console.log(`Firecrawl content: ${mdPath} (${(markdown.length / 1024).toFixed(0)}KB)`);
    }

    return screenshotUrl ? true : (markdown && markdown.length > 50);
  } catch (e) {
    // Firecrawl might reject certain sites
    const msg = e.stderr?.toString() || e.message || '';
    console.log('Firecrawl error:', msg.substring(0, 200));

    // If it's a "site not supported" error, that's final
    if (msg.includes('do not support this site')) {
      console.log('Site not supported by Firecrawl');
      return false;
    }
    return false;
  }
}

// ─── Helpers ───
function getContentType(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        resolve(getContentType(res.headers.location));
      else resolve(res.headers['content-type'] || '');
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
        resolve(downloadBuffer(res.headers.location)); return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
