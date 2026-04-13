# HyprAds — AI Landing Page Personalizer

## What This Is
An AI agent that clones any landing page and personalizes it based on an ad creative using CRO principles. The output is a self-contained static HTML file that can be served from any web app.

## Tech Stack
- **Runtime:** Node.js 20+, Playwright (headless Chromium)
- **Agent:** Claude Agent SDK (TypeScript) with Playwright MCP
- **Core script:** `scripts/clone-page.mjs` — clones any URL to self-contained HTML
- **Output:** Single HTML file with inlined CSS, absolute asset URLs, no framework JS

## Architecture
```
User sends: { url, adCreative } via REST API
  → Agent SDK runs clone-and-personalize skill
    → Step 1: Run clone-page.mjs to get static HTML
    → Step 2: Analyze ad creative (text/image) for messaging, tone, audience
    → Step 3: Surgically edit HTML (headlines, CTAs, social proof, imagery)
    → Step 4: Return modified HTML
```

## Commands
- `node scripts/clone-page.mjs <url> <output-dir>` — Clone a website to static HTML

## Critical Rules (learned the hard way)

### Cloning
- **NEVER keep framework JS** (React, Next.js, Nuxt). It crashes cross-origin and overwrites CRO edits via hydration.
- **ALWAYS strip `<script>`, `<noscript>`, `<iframe>` tags.** Only inject our tiny video-autoplay helper.
- **ALWAYS fetch external CSS via `fetch()` while on the original domain** (same-origin, no CORS), then inline it.
- **ALWAYS scroll the full page before extracting HTML** — triggers lazy loading and IntersectionObserver.
- **ALWAYS use `page.content()`** for HTML extraction, never `page.evaluate(() => outerHTML)` with filename param (double-escapes).
- Animated `<canvas>` elements (WebGL/Three.js): detect by comparing two screenshots 1s apart. If animated, remove it cleanly — don't try to replace with video fallback.
- Static `<canvas>`: freeze to base64 PNG via Playwright `element.screenshot()` (not `toDataURL` which returns blank for WebGL).

### CRO Personalization
- The personalized page must be the **original page enhanced**, not a new page.
- Only modify: headlines, subheadlines, CTAs, hero copy, social proof placement, urgency elements.
- Never change: layout, navigation, footer, brand colors, images (unless directly relevant to ad).
- Every edit must be traceable to something in the ad creative.

### URL Rewriting
- Rewrite ALL relative URLs to absolute: `src`, `href`, `poster`, `action`, `srcset`
- Watch for Next.js `/_next/image?url=` patterns in srcset
- CSS relative URLs (`../media/`, `../chunks/`) resolve against the stylesheet's original URL
- Inline styles `url()` patterns need rewriting too

## Project Structure
```
scripts/
  clone-page.mjs          # Core cloning script (Playwright headless)
.claude/
  skills/
    clone-and-personalize/ # Main skill — orchestrates clone → analyze → edit
      SKILL.md             # Full pipeline with CRO framework synthesized from
                           # coreyhaines31/marketingskills (page-cro, copywriting,
                           # ad-creative, marketing-psychology)
clones/                    # Output directory for cloned sites
screenshots/               # Reference screenshots
```
