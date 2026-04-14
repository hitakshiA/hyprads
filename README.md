# HyprAds

AI-powered landing page personalizer. User inputs an ad creative + landing page URL → gets a personalized landing page that matches the ad using CRO principles.

**Live API:** `http://159.89.164.228:3000`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND APP                         │
│  User pastes URL + uploads/links ad creative             │
│  Connects to /personalize/stream via SSE                 │
│  Shows real-time progress → renders before/after         │
└────────────────────────┬────────────────────────────────┘
                         │ POST /personalize/stream
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   EXPRESS API (server.mjs)                │
│  :3000 on DigitalOcean                                   │
│                                                          │
│  1. Receives { url, adCreative }                         │
│  2. If ad is a URL → capture-ad.mjs screenshots it       │
│  3. Spawns Claude Agent (Opus 4.6) with the skill        │
│  4. Streams SSE events back to frontend                  │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   clone-page.mjs   Claude Agent   capture-ad.mjs
   (Playwright)     (reads SKILL.md,  (Playwright)
   URL → HTML       edits HTML)     URL → screenshot
```

---

## API Reference

Base URL: `http://159.89.164.228:3000`

### `GET /health`

```json
// Response
{"status": "ok", "uptime": 128.05}
```

---

### `POST /clone`

Clone a website to self-contained HTML. No AI, just Playwright. Fast (~20s).

```json
// Request
{"url": "https://cal.com"}

// Response
{
  "jobId": "eb1e6896",
  "url": "https://cal.com",
  "html": "<!DOCTYPE html>...",  // Full self-contained HTML
  "sizeKB": 1362,
  "elapsed": "20.2s"
}
```

---

### `POST /personalize`

Clone + personalize. Returns final result (waits for completion, ~3-5 min).

**Three ways to pass the ad creative:**

```json
// 1. Text description
{
  "url": "https://cal.com",
  "adCreativeText": "50% off scheduling for startup teams — try free for 30 days"
}

// 2. URL to ad (webpage gets screenshotted, image gets downloaded)
{
  "url": "https://cal.com",
  "adCreativeUrl": "https://www.facebook.com/ads/library/?id=123456"
}

// 3. Base64 image upload
{
  "url": "https://cal.com",
  "adCreativeBase64": "iVBORw0KGgoAAAANSUhEUg..."
}
```

```json
// Response
{
  "jobId": "8cfcab56",
  "url": "https://cal.com",
  "html": "<!DOCTYPE html>...",     // Personalized HTML
  "changes": "# Personalization Report\n...",  // Markdown report
  "analysis": "# Ad Creative Analysis\n...",   // Ad analysis
  "sizeKB": 1400,
  "cost": 0.71
}
```

---

### `POST /personalize/stream` ⭐ Recommended

Same input as `/personalize`, but returns **Server-Sent Events** for real-time progress.

```json
// Request (same as /personalize)
{
  "url": "https://dub.co",
  "adCreativeText": "Shorten links, track clicks, grow revenue — free for startups"
}
```

**SSE event stream:**

```
data: {"stage":"started","message":"Job 8cfcab56 started","data":{"jobId":"8cfcab56","url":"https://dub.co"}}
data: {"stage":"ad_processing","message":"Using text ad creative"}
data: {"stage":"agent_starting","message":"Starting Claude agent..."}
data: {"stage":"cloning","message":"Cloning https://dub.co..."}
data: {"stage":"cloned","message":"Page cloned (2135KB)","data":{"sizeKB":2135}}
data: {"stage":"analyzing_page","message":"Reading cloned page..."}
data: {"stage":"personalizing","message":"Editing page: \"Shorten links, track clicks, grow revenue\""}
data: {"stage":"personalizing","message":"Editing page: \"Start Free for Startups\""}
data: {"stage":"verifying","message":"Running anti-hallucination checks..."}
data: {"stage":"report","message":"Writing change report..."}
data: {"stage":"complete","message":"Personalization complete","data":{"jobId":"8cfcab56","viewUrl":"/clone/8cfcab56","changes":"...","analysis":"..."}}
data: [DONE]
```

**All SSE stages:**

| Stage | Meaning | When it fires |
|-------|---------|---------------|
| `started` | Job created | Immediately |
| `ad_processing` | Handling ad input | After validation |
| `ad_captured` | Ad URL screenshotted | After Playwright capture |
| `agent_starting` | Claude agent spawned | Before first LLM call |
| `cloning` | Playwright cloning page | When clone-page.mjs runs |
| `cloned` | Clone complete | Clone script finished (includes sizeKB) |
| `analyzing_page` | Reading cloned HTML | Agent reads the file |
| `analyzing_ad` | Reading ad creative | Agent reads the image/text |
| `personalizing` | Making an edit | Each Edit tool call (includes preview) |
| `verifying` | Anti-hallucination check | Agent verifies edits |
| `report` | Writing reports | ad-analysis.md or changes.md |
| `finishing` | Wrapping up | Agent's final summary |
| `agent_done` | Agent complete | Includes result text and cost |
| `complete` | Everything done | Includes jobId, viewUrl, changes, analysis |
| `error` | Something failed | Includes error message |

---

### `GET /clone/:jobId`

Serves the personalized HTML page directly. Can be iframed or opened in a new tab.

```
http://159.89.164.228:3000/clone/8cfcab56
```

### `GET /clone/:jobId/changes`

Returns the change report (Markdown).

### `GET /clone/:jobId/analysis`

Returns the ad creative analysis (Markdown).

---

## Frontend Integration Guide

### Minimal example (vanilla JS)

```html
<!DOCTYPE html>
<html>
<body>
  <input id="url" placeholder="Landing page URL" value="https://cal.com" />
  <textarea id="ad" placeholder="Ad creative text">50% off for startups</textarea>
  <button onclick="run()">Personalize</button>
  <div id="status"></div>
  <iframe id="result" style="width:100%;height:600px;border:1px solid #ccc;display:none;"></iframe>

  <script>
    const API = 'http://159.89.164.228:3000';

    async function run() {
      const url = document.getElementById('url').value;
      const adCreativeText = document.getElementById('ad').value;
      const status = document.getElementById('status');
      const iframe = document.getElementById('result');

      status.textContent = 'Starting...';
      iframe.style.display = 'none';

      const res = await fetch(`${API}/personalize/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, adCreativeText }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

          const event = JSON.parse(line.slice(6));
          status.textContent = `[${event.stage}] ${event.message}`;

          // When complete, show the personalized page in iframe
          if (event.stage === 'complete' && event.data?.viewUrl) {
            iframe.src = `${API}${event.data.viewUrl}`;
            iframe.style.display = 'block';
          }
        }
      }
    }
  </script>
</body>
</html>
```

### React example

```jsx
import { useState } from 'react';

const API = 'http://159.89.164.228:3000';

export default function Personalizer() {
  const [url, setUrl] = useState('');
  const [adText, setAdText] = useState('');
  const [stages, setStages] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setStages([]);
    setResult(null);

    const res = await fetch(`${API}/personalize/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, adCreativeText: adText }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const event = JSON.parse(line.slice(6));

        setStages(prev => [...prev, event]);

        if (event.stage === 'complete') {
          setResult(event.data);
          setLoading(false);
        }
        if (event.stage === 'error') {
          setLoading(false);
        }
      }
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Landing page URL" />
        <textarea value={adText} onChange={e => setAdText(e.target.value)} placeholder="Ad creative text" />
        <button type="submit" disabled={loading}>
          {loading ? 'Personalizing...' : 'Personalize'}
        </button>
      </form>

      {/* Progress stages */}
      <div>
        {stages.map((s, i) => (
          <div key={i} style={{ opacity: i === stages.length - 1 ? 1 : 0.5 }}>
            [{s.stage}] {s.message}
          </div>
        ))}
      </div>

      {/* Result iframe */}
      {result && (
        <iframe
          src={`${API}${result.viewUrl}`}
          style={{ width: '100%', height: '80vh', border: '1px solid #ccc' }}
        />
      )}
    </div>
  );
}
```

### Handling image uploads (base64)

```javascript
// File input → base64
const fileInput = document.getElementById('adImage');
const file = fileInput.files[0];
const reader = new FileReader();
reader.onload = () => {
  const base64 = reader.result.split(',')[1]; // strip data:image/png;base64,
  fetch(`${API}/personalize/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, adCreativeBase64: base64 }),
  });
};
reader.readAsDataURL(file);
```

### Handling ad URL input

```javascript
// User pastes a URL to an ad (Meta Ad Library, Google Ads, tweet, any webpage)
fetch(`${API}/personalize/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://cal.com',
    adCreativeUrl: 'https://www.facebook.com/ads/library/?id=123456'
  }),
});
// The server auto-detects if the URL is a direct image or a webpage
// Images are downloaded directly, webpages are screenshotted via Playwright
```

---

## What the frontend should show

### Input screen
- Text field for landing page URL
- Three-way toggle for ad creative input: **Text** / **Image upload** / **URL**
- "Personalize" button

### Processing screen (SSE stages)
- Step-by-step progress indicator showing each stage
- Suggested UX: vertical timeline or stepper with stage names and messages
- The `personalizing` events include preview text of each edit being made

### Result screen
- **Before/after comparison**: original URL in one iframe, `GET /clone/:jobId` in the other
- **Change report**: render the `changes` markdown from the `complete` event
- **Ad analysis**: render the `analysis` markdown from the `complete` event
- **Direct link**: `http://159.89.164.228:3000/clone/:jobId` — shareable URL to the personalized page

---

## SSE Event Schema (TypeScript)

```typescript
interface SSEEvent {
  stage:
    | 'started'        // Job created
    | 'ad_processing'  // Handling ad input
    | 'ad_captured'    // Ad URL screenshotted
    | 'agent_starting' // Claude agent spawned
    | 'cloning'        // Playwright running
    | 'cloned'         // Clone finished
    | 'analyzing_page' // Agent reading HTML
    | 'analyzing_ad'   // Agent reading ad
    | 'personalizing'  // Agent making edits
    | 'verifying'      // Anti-hallucination check
    | 'report'         // Writing reports
    | 'finishing'      // Agent wrapping up
    | 'agent_done'     // Agent process complete
    | 'complete'       // Everything done, files ready
    | 'error';         // Something failed

  message: string;     // Human-readable status
  timestamp: number;   // Unix ms

  data?: {
    jobId?: string;
    url?: string;
    sizeKB?: number;
    viewUrl?: string;       // GET this to render personalized page
    changes?: string;       // Markdown change report
    analysis?: string;      // Markdown ad analysis
    result?: string;        // Agent's final summary
    cost?: number;          // USD cost of this run
    tool?: string;          // Which tool was used (for 'personalizing')
  };
}
```

---

## Project structure

```
server.mjs                         # Express API — clone, personalize, SSE streaming
scripts/
  clone-page.mjs                   # Playwright website cloner (URL → static HTML)
  capture-ad.mjs                   # Ad URL → screenshot (auto-detects image vs webpage)
.claude/
  skills/
    clone-and-personalize/
      SKILL.md                     # CRO personalization skill for Claude agent
CLAUDE.md                          # Project context the agent reads on startup
package.json                       # Dependencies: express, playwright
```

## Server deployment

Running on DigitalOcean (2 vCPU, 2GB RAM, Ubuntu 24.04).

```bash
npm install
npm run setup       # installs headless Chromium
npm start           # starts API on :3000
```

Requires Claude Code CLI authenticated as a non-root user with `--dangerously-skip-permissions` enabled.

## Cost per request

| Endpoint | Cost | Time |
|----------|------|------|
| `/clone` | $0 (no AI) | ~20s |
| `/personalize` | ~$0.70-1.10 | ~3-5 min |

Dominant cost is Claude Opus 4.6 tokens, not compute.
