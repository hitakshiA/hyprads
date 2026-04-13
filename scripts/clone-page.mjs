#!/usr/bin/env node
// Clone a website to a self-contained static HTML file.
// No framework JS — the output is a passive document safe for CRO editing.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { URL } from 'url';

const url = process.argv[2] || 'https://resend.com';
const outDir = process.argv[3] || 'clones/output';
const outFile = resolve(outDir, 'index.html');
mkdirSync(outDir, { recursive: true });

const origin = new URL(url).origin;
console.log(`Cloning ${url}...`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// ─── Load & scroll ───
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
console.log('Page loaded.');

console.log('Scrolling to trigger lazy loading...');
const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < scrollHeight; y += 630) {
  await page.evaluate((sy) => window.scrollTo(0, sy), y);
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(2000);
await page.waitForLoadState('networkidle');
console.log('Scroll complete.');

// Reference screenshot
await page.screenshot({ fullPage: true, path: resolve(outDir, 'original.png') });

// ─── Handle canvas elements ───
// Animated canvases → unhide video fallback. Static → freeze to PNG.
const canvasEls = await page.$$('canvas');
for (let i = 0; i < canvasEls.length; i++) {
  try {
    const box = await canvasEls[i].boundingBox();
    if (!box || box.width === 0 || box.height === 0) continue;

    const buf1 = await canvasEls[i].screenshot({ type: 'png' });
    await page.waitForTimeout(1000);
    const buf2 = await canvasEls[i].screenshot({ type: 'png' });
    const animated = !buf1.equals(buf2);

    if (animated) {
      // Animated canvas (WebGL/Three.js) — can't reproduce cross-origin. Remove cleanly.
      await page.evaluate((idx) => {
        const c = document.querySelectorAll('canvas')[idx];
        if (c) c.remove();
      }, i);
      console.log(`  Canvas ${i}: animated → removed (can't reproduce cross-origin)`);
    } else {
      const b64 = buf1.toString('base64');
      await page.evaluate(({ idx, d, w, h }) => {
        const c = document.querySelectorAll('canvas')[idx]; if (!c) return;
        const img = document.createElement('img'); img.src = d;
        img.style.width = w+'px'; img.style.height = h+'px';
        img.className = c.className;
        if (c.getAttribute('style')) img.setAttribute('style', c.getAttribute('style'));
        c.parentElement.replaceChild(img, c);
      }, { idx: i, d: `data:image/png;base64,${b64}`, w: box.width, h: box.height });
      console.log(`  Canvas ${i}: static → froze to PNG`);
    }
  } catch (e) { /* skip */ }
}

// ─── Extract CSS ───
const externalCSS = await page.evaluate(async () => {
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  let css = '';
  for (const link of links) {
    try { css += await (await fetch(link.href)).text() + '\n'; } catch (e) {}
  }
  return css;
});
console.log(`Fetched ${(externalCSS.length / 1024).toFixed(0)}KB CSS.`);

// ─── Clean DOM ───
await page.evaluate(() => {
  // Lazy images
  document.querySelectorAll('img[data-src]').forEach(img => { if (img.dataset.src) img.src = img.dataset.src; });
  document.querySelectorAll('img[loading="lazy"]').forEach(img => img.removeAttribute('loading'));
  document.querySelectorAll('img[srcset]').forEach(img => { if (img.currentSrc) img.src = img.currentSrc; });

  // Videos: ensure autoplay attrs
  document.querySelectorAll('video').forEach(v => {
    v.setAttribute('autoplay', ''); v.setAttribute('muted', '');
    v.setAttribute('loop', ''); v.setAttribute('playsinline', '');
  });

  // Strip everything unnecessary
  document.querySelectorAll('link[rel="stylesheet"]').forEach(el => el.remove());
  document.querySelectorAll('script').forEach(el => el.remove());
  document.querySelectorAll('noscript').forEach(el => el.remove());
  document.querySelectorAll('iframe').forEach(el => el.remove());
  document.querySelectorAll('link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], link[rel="manifest"]').forEach(el => el.remove());
});

// ─── Get HTML & fix URLs ───
let html = await page.content();

// Strip iframes from HTML string (they may be re-injected after evaluate)
html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');

// srcset
html = html.replace(/srcset=(["'])((?:(?!\1).)*)\1/g, (m, q, s) =>
  `srcset=${q}${s.replace(/(\/(?:_next\/image)[^,\s]*)/g, `${origin}$1`)}${q}`);
// src, href, poster, action
html = html.replace(/(src|href|poster|action)=(["'])\/(?!\/)/g, `$1=$2${origin}/`);
// url() in inline styles
html = html.replace(/url\(\//g, `url(${origin}/`);
html = html.replace(/url\('\//g, `url('${origin}/`);
html = html.replace(/url\("\//g, `url("${origin}/`);

// Fix CSS relative URLs
let css = externalCSS;
css = css.replace(/url\((["']?)((?!data:|https?:|\/\/|#)[^)]+)\1\)/g, (m, q, p) => {
  let a = p.trim();
  if (a.startsWith('../media/')) a = `${origin}/_next/static/media/${a.slice(9)}`;
  else if (a.startsWith('../chunks/')) a = `${origin}/_next/static/chunks/${a.slice(10)}`;
  else if (a.startsWith('../')) a = `${origin}/_next/static/${a.slice(3)}`;
  else if (a.startsWith('./')) a = `${origin}/${a.slice(2)}`;
  else if (a.startsWith('/')) a = `${origin}${a}`;
  return `url(${q}${a}${q})`;
});

// Inject CSS
html = html.replace('</head>', `<style id="cloned-css">\n${css}\n</style>\n</head>`);

// Inject video autoplay helper (our only script — tiny, no framework)
html = html.replace('</body>', `<script>
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('video').forEach(function(v){v.muted=true;v.play().catch(function(){});});
});
</script>\n</body>`);

writeFileSync(outFile, html, 'utf8');
console.log(`\nClone: ${outFile} (${(html.length / 1024).toFixed(0)}KB)`);
await browser.close();
