# HyprAds

AI-powered landing page personalizer. Input an ad creative + landing page URL, get a personalized landing page that matches the ad using CRO principles.

Built for the [Troopod AI PM Assignment](mailto:nj@troopod.io).

## How it works

```
Ad Creative + Landing Page URL
        │
        ▼
┌──────────────────────────────┐
│  1. CLONE                    │
│  Playwright headless browser │
│  → scrolls full page         │
│  → inlines all CSS           │
│  → fixes asset URLs          │
│  → strips framework JS       │
│  → outputs static HTML       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  2. ANALYZE                  │
│  Claude (multimodal) reads   │
│  the ad creative and         │
│  extracts: offer, audience,  │
│  tone, CTA intent, angle     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  3. PERSONALIZE              │
│  Surgical HTML edits:        │
│  - Hero headline             │
│  - Subheadline               │
│  - CTA button text           │
│  - Trust signals (if needed) │
│  Using CRO message-match     │
└──────────────┬───────────────┘
               │
               ▼
     Personalized HTML
     (self-contained, servable)
```

## Key design decisions

**Static HTML, no framework JS.** Framework JS (React/Next.js) crashes when served cross-origin and overwrites CRO edits via hydration. The clone is a passive document the agent can surgically edit.

**Existing page enhanced, not rebuilt.** The assignment says "the personalized page shouldn't be a completely new page." We clone the real page and only change headlines, CTAs, and copy to match the ad.

**CRO framework synthesized from battle-tested sources.** The personalization skill draws from [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (20K+ stars) — specifically page-cro, copywriting, ad-creative, and marketing-psychology — combined into one purpose-built pipeline.

## Quick start

```bash
# Install
npm install
npm run setup  # installs headless Chromium

# Clone a website
npm run clone -- https://resend.com clones/resend

# Full pipeline (via Claude Agent SDK)
# See "Agent SDK Integration" below
```

## Project structure

```
scripts/
  clone-page.mjs              # Playwright-based website cloner
.claude/
  skills/
    clone-and-personalize/
      SKILL.md                 # Full pipeline skill for Claude Agent SDK
CLAUDE.md                      # Project context for the agent
```

## The cloning script

`scripts/clone-page.mjs` takes any URL and produces a self-contained HTML file.

**What it does:**
- Launches headless Chromium via Playwright
- Scrolls the full page (triggers lazy loading, IntersectionObserver, scroll-driven classes)
- Detects animated canvases (WebGL/Three.js) by comparing two screenshots 1s apart — removes them cleanly
- Freezes static canvases to PNG via element screenshot
- Fetches all external CSS on same-origin (no CORS), inlines it
- Strips all `<script>`, `<noscript>`, `<iframe>` tags
- Rewrites all relative URLs to absolute (src, href, poster, srcset, CSS url())
- Handles Next.js `/_next/image?url=` patterns in srcset
- Injects a tiny video-autoplay helper as the only script
- Outputs a single HTML file + reference screenshot

**Tested on:** resend.com, cal.com, dub.co — 93-95% visual fidelity.

## Agent SDK integration

The skill at `.claude/skills/clone-and-personalize/SKILL.md` is designed for the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/custom-tools).

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: '/clone-and-personalize https://resend.com "50% off email API for dev teams — start free trial"',
  options: {
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
  }
})) {
  if ("result" in message) {
    // message.result contains the personalization report
    // clones/output/index.html contains the personalized HTML
  }
}
```

### As a REST API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import express from "express";
import { readFileSync } from "fs";

const app = express();
app.use(express.json());

app.post("/personalize", async (req, res) => {
  const { url, adCreative } = req.body;

  for await (const msg of query({
    prompt: `/clone-and-personalize ${url} "${adCreative}"`,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
    }
  })) {
    if ("result" in msg) {
      const html = readFileSync("clones/output/index.html", "utf8");
      res.json({ html, report: msg.result });
    }
  }
});

app.listen(3000);
```

## CRO personalization approach

The skill applies a 5-phase pipeline:

1. **Clone** — `clone-page.mjs` produces static HTML
2. **Analyze** — Extract ad signals: offer, audience, angle, tone, CTA intent
3. **Personalize** — Surgical edits in priority order:
   - Hero headline (message match — 80% of impact)
   - Subheadline (expand with specifics)
   - Primary CTA (match ad's intended action)
   - Trust signals (only if ad uses social proof angle)
4. **Anti-hallucination checks** — Every claim must trace to the ad or original page
5. **Output** — Modified HTML + change report

## What doesn't get edited

- Navigation, footer, brand logos
- Layout, CSS, spacing, colors
- Images (unless directly relevant)
- Any URLs or link targets
- Sections below the fold unrelated to the ad

## Handling edge cases

| Issue | How it's handled |
|-------|-----------------|
| **Random changes** | Edit priority system — only touch headline, subheadline, CTA, trust signals. Everything else is untouched. |
| **Broken UI** | No JS, no CSS changes, no layout changes. Only text content inside existing tags is modified. |
| **Hallucinations** | 5-point anti-hallucination checklist. Every claim must trace to the ad or original page. "When in doubt, don't edit." |
| **Inconsistent outputs** | Structured pipeline with explicit phases. Ad analysis is saved to file before edits begin. Change report documents every edit with rationale. |
| **Framework JS crashes** | All scripts stripped during cloning. Output is passive HTML. |
| **WebGL/canvas elements** | Animated canvases detected and removed cleanly. Static canvases frozen to PNG. |
| **Lazy-loaded content** | Full-page scroll during cloning triggers all lazy loading before HTML extraction. |
