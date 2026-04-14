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
│  → self-contained HTML       │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  2. ANALYZE                  │
│  Claude (multimodal) reads   │
│  the ad creative: offer,     │
│  audience, tone, CTA, angle  │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  3. PERSONALIZE              │
│  Surgical HTML edits:        │
│  headline, subheadline,      │
│  CTAs, trust signals         │
└──────────────┬───────────────┘
               ▼
     Personalized HTML + Report
```

## API

Live at `http://159.89.164.228:3000`

### `POST /clone` — Clone a website

```json
{"url": "https://example.com"}
```

Returns: `{ jobId, html, sizeKB, elapsed }`

### `POST /personalize` — Clone + personalize (non-streaming)

Three ways to pass ad creative:

```json
// Text description
{"url": "https://cal.com", "adCreativeText": "50% off scheduling for startups"}

// URL to ad (image or webpage — auto-screenshotted via Playwright)
{"url": "https://cal.com", "adCreativeUrl": "https://facebook.com/ads/library/..."}

// Direct image upload (base64)
{"url": "https://cal.com", "adCreativeBase64": "iVBORw0KGgo..."}
```

Returns: `{ jobId, html, changes, analysis, sizeKB, cost }`

### `POST /personalize/stream` — Clone + personalize (SSE streaming)

Same body as `/personalize`, returns Server-Sent Events:

```
stage: started          → Job started
stage: ad_processing    → Processing ad creative...
stage: cloning          → Cloning https://cal.com...
stage: cloned           → Page cloned (1400KB)
stage: analyzing_page   → Reading cloned page...
stage: personalizing    → Editing page: "50% off scheduling..."
stage: personalizing    → Editing page: "Start your free trial..."
stage: verifying        → Running anti-hallucination checks...
stage: report           → Writing change report...
stage: complete         → { jobId, viewUrl, changes, analysis }
```

Frontend consumption:
```javascript
const res = await fetch('/personalize/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, adCreativeText })
});
for await (const chunk of res.body) {
  const lines = new TextDecoder().decode(chunk).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const event = JSON.parse(line.slice(6));
      updateUI(event.stage, event.message);
    }
  }
}
```

### `GET /clone/:jobId` — View personalized page
### `GET /clone/:jobId/changes` — Change report
### `GET /clone/:jobId/analysis` — Ad analysis

## Ad creative input handling

| Input type | How it's handled |
|-----------|-----------------|
| **Text** (`adCreativeText`) | Passed directly to Claude agent (multimodal) |
| **Image URL** (`adCreativeUrl`) | `Content-Type` checked — if `image/*`, downloaded directly. Otherwise Playwright screenshots the page. Covers Meta Ad Library, Google Ads, LinkedIn ads, tweets, any URL. |
| **Base64 image** (`adCreativeBase64`) | Decoded and saved as PNG, passed to agent |

## Key design decisions

**Static HTML, no framework JS.** Framework JS crashes cross-origin and overwrites CRO edits via hydration. The clone is a passive document the agent can surgically edit.

**Existing page enhanced, not rebuilt.** The assignment says "the personalized page shouldn't be a completely new page." We clone the real page and only modify copy.

**CRO framework from battle-tested sources.** Synthesized from [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (20K+ stars) — page-cro, copywriting, ad-creative, and marketing-psychology.

**Real-time progress via SSE.** The streaming endpoint lets frontends show each stage as it happens instead of a loading spinner.

## Project structure

```
server.mjs                         # Express API with SSE streaming
scripts/
  clone-page.mjs                   # Playwright website cloner
  capture-ad.mjs                   # Ad creative URL → screenshot
.claude/
  skills/
    clone-and-personalize/
      SKILL.md                     # Full CRO pipeline skill
CLAUDE.md                          # Project context for the agent
```

## CRO personalization pipeline

1. **Clone** — `clone-page.mjs` produces static HTML
2. **Analyze** — Extract ad signals: offer, audience, angle, tone, CTA intent
3. **Personalize** — Surgical edits in priority order: hero headline (80% impact) → subheadline → CTA → trust signals
4. **Anti-hallucination checks** — Every claim must trace to the ad or original page
5. **Output** — Modified HTML + ad analysis + change report with rationale

## Handling edge cases

| Issue | How it's handled |
|-------|-----------------|
| **Random changes** | Edit priority system — only headline, subheadline, CTA, trust signals touched |
| **Broken UI** | No JS/CSS/layout changes. Only text content inside existing tags modified |
| **Hallucinations** | 5-point anti-hallucination checklist. Every claim traces to ad or original page |
| **Inconsistent outputs** | Structured pipeline with explicit phases. Ad analysis saved before edits begin |
| **Framework JS crashes** | All scripts stripped during cloning |
| **WebGL/canvas** | Animated canvases detected and removed. Static ones frozen to PNG |
| **Lazy-loaded content** | Full-page scroll triggers all lazy loading before extraction |

## Deployment

Running on DigitalOcean (2 vCPU, 2GB RAM, Ubuntu 24.04).

```bash
# Server
npm install
npm run setup  # installs headless Chromium
npm start      # starts API on port 3000
```

Requires Claude Code CLI authenticated (`claude` command must be logged in).

## Cost per request

- Clone only: ~$0 (no LLM, just Playwright)
- Personalize: ~$0.70-1.10 (Claude Opus 4.6, ~40 turns)
- Dominant cost is tokens, not compute
