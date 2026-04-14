#!/usr/bin/env node
// HyprAds API Server — website cloning & ad-to-page personalization
// Supports SSE streaming for real-time progress updates
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { createInterface } from 'readline';

const exec = promisify(execFile);
const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const CLONE_DIR = resolve('./clones');

// ─── Frontend ───
app.get('/', (req, res) => {
  const frontendPath = resolve('./frontend/index.html');
  if (existsSync(frontendPath)) {
    res.type('html').send(readFileSync(frontendPath, 'utf8'));
  } else {
    res.json({ status: 'ok', service: 'hyprads', endpoints: ['POST /clone', 'POST /personalize', 'POST /personalize/stream', 'GET /clone/:jobId'] });
  }
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Clone only ───
app.post('/clone', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const jobId = crypto.randomBytes(8).toString('hex');
  const outDir = resolve(CLONE_DIR, jobId);
  mkdirSync(outDir, { recursive: true });

  console.log(`[${jobId}] Cloning ${url}...`);
  const start = Date.now();

  try {
    await exec('node', ['scripts/clone-page.mjs', url, outDir], { timeout: 600000, cwd: process.cwd() });
    const htmlPath = resolve(outDir, 'index.html');
    if (!existsSync(htmlPath)) return res.status(500).json({ error: 'Clone failed — no HTML output' });

    const html = readFileSync(htmlPath, 'utf8');
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${jobId}] Cloned in ${elapsed}s — ${(html.length / 1024).toFixed(0)}KB`);
    res.json({ jobId, url, html, sizeKB: Math.round(html.length / 1024), elapsed: `${elapsed}s` });
  } catch (err) {
    res.status(500).json({ error: 'Clone failed', message: err.message });
  }
});

// ─── Personalize (non-streaming, returns final result) ───
app.post('/personalize', async (req, res) => {
  const result = await runPersonalization(req.body);
  if (result.error) return res.status(result.status || 500).json(result);
  res.json(result);
});

// ─── Personalize with SSE streaming ───
app.post('/personalize/stream', async (req, res) => {
  const { url, adCreativeUrl, adCreativeText, adCreativeBase64 } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!adCreativeUrl && !adCreativeText && !adCreativeBase64) {
    return res.status(400).json({ error: 'One of adCreativeUrl, adCreativeText, or adCreativeBase64 is required' });
  }
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (stage, message, data) => {
    res.write(`data: ${JSON.stringify({ stage, message, data, timestamp: Date.now() })}\n\n`);
  };

  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = resolve(CLONE_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  send('started', `Job ${jobId} started`, { jobId, url });

  try {
    // Step 1: Handle ad creative
    let adArg = '';

    if (adCreativeBase64) {
      send('ad_processing', 'Processing uploaded ad image...');
      const imgBuf = Buffer.from(adCreativeBase64, 'base64');
      const imgPath = resolve(jobDir, 'ad-creative.png');
      writeFileSync(imgPath, imgBuf);
      adArg = imgPath;
    } else if (adCreativeUrl) {
      send('ad_processing', `Capturing ad from ${adCreativeUrl}...`);
      const imgPath = resolve(jobDir, 'ad-creative.png');
      await exec('node', ['scripts/capture-ad.mjs', adCreativeUrl, imgPath], { timeout: 60000, cwd: process.cwd() });
      adArg = imgPath;
      send('ad_captured', 'Ad creative captured');
    } else {
      adArg = `"${adCreativeText.replace(/"/g, '\\"')}"`;
      send('ad_processing', 'Using text ad creative');
    }

    // Step 2: Run Claude agent with stream-json output
    const prompt = `/clone-and-personalize ${url} ${adArg}`;
    send('agent_starting', 'Starting Claude agent...');

    const child = spawn('su', ['-', 'hyprads', '-c',
      `cd /home/hyprads/hyprads && claude --dangerously-skip-permissions -p '${prompt.replace(/'/g, "'\\''")}' --allowedTools Read,Write,Edit,Bash,Glob,Grep --output-format stream-json --verbose`
    ], {
      cwd: process.cwd(),
    });

    const rl = createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);

        // Detect stages from agent messages
        if (msg.type === 'assistant' && msg.message?.content) {
          const contents = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
          for (const block of contents) {
            // Tool use — detect what stage we're in
            if (block.type === 'tool_use') {
              const tool = block.name;
              const input = block.input || {};

              if (tool === 'Bash' && typeof input.command === 'string') {
                if (input.command.includes('clone-page.mjs')) {
                  send('cloning', `Cloning ${url}...`);
                } else if (input.command.includes('capture-ad')) {
                  send('ad_capturing', 'Capturing ad creative...');
                }
              } else if (tool === 'Read') {
                const path = input.file_path || '';
                if (path.includes('index.html')) {
                  send('analyzing_page', 'Reading cloned page...');
                } else if (path.includes('ad-creative')) {
                  send('analyzing_ad', 'Analyzing ad creative...');
                }
              } else if (tool === 'Edit') {
                const path = input.file_path || '';
                if (path.includes('index.html')) {
                  // Try to extract what's being changed
                  const newStr = input.new_string || '';
                  const preview = newStr.substring(0, 80).replace(/\n/g, ' ');
                  send('personalizing', `Editing page: "${preview}..."`, { tool: 'Edit' });
                }
              } else if (tool === 'Write') {
                const path = input.file_path || '';
                if (path.includes('changes.md')) {
                  send('report', 'Writing change report...');
                } else if (path.includes('ad-analysis.md')) {
                  send('report', 'Writing ad analysis...');
                }
              }
            }

            // Text content from the agent
            if (block.type === 'text' && block.text) {
              const text = block.text.toLowerCase();
              if (text.includes('anti-hallucination') || text.includes('verification')) {
                send('verifying', 'Running anti-hallucination checks...');
              } else if (text.includes('personalization complete') || text.includes('changes made')) {
                send('finishing', 'Finalizing personalization...');
              }
            }
          }
        }

        // Tool results
        if (msg.type === 'tool_result') {
          // Clone script finished
          if (typeof msg.content === 'string' && msg.content.includes('Clone:')) {
            const match = msg.content.match(/Clone:.*\((\d+)KB\)/);
            if (match) send('cloned', `Page cloned (${match[1]}KB)`, { sizeKB: parseInt(match[1]) });
          }
        }

        // Final result
        if (msg.type === 'result') {
          send('agent_done', 'Agent finished', { result: msg.result, cost: msg.total_cost_usd });
        }

      } catch { /* skip unparseable lines */ }
    });

    // Wait for process to finish
    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Agent exited with code ${code}`));
      });
      child.on('error', reject);
      // 10 min timeout
      setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 600000);
    });

    // Read final output files
    const agentOutDir = '/home/hyprads/hyprads/clones/output';
    const htmlPath = resolve(agentOutDir, 'index.html');
    const changesPath = resolve(agentOutDir, 'changes.md');
    const analysisPath = resolve(agentOutDir, 'ad-analysis.md');

    const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : null;
    const changes = existsSync(changesPath) ? readFileSync(changesPath, 'utf8') : null;
    const analysis = existsSync(analysisPath) ? readFileSync(analysisPath, 'utf8') : null;

    // Copy to job dir for persistent access
    if (html) writeFileSync(resolve(jobDir, 'index.html'), html);
    if (changes) writeFileSync(resolve(jobDir, 'changes.md'), changes);
    if (analysis) writeFileSync(resolve(jobDir, 'ad-analysis.md'), analysis);
    const origPath = resolve(agentOutDir, 'original.html');
    if (existsSync(origPath)) writeFileSync(resolve(jobDir, 'original.html'), readFileSync(origPath));

    send('complete', 'Personalization complete', {
      jobId,
      url,
      html: html ? true : false,
      sizeKB: html ? Math.round(html.length / 1024) : 0,
      changes,
      analysis,
      viewUrl: `/clone/${jobId}`,
    });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    send('error', err.message);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── Serve cloned/personalized page ───
app.get('/clone/:jobId', (req, res) => {
  const htmlPath = resolve(CLONE_DIR, req.params.jobId, 'index.html');
  if (!existsSync(htmlPath)) return res.status(404).json({ error: 'Not found' });
  res.type('html').send(readFileSync(htmlPath, 'utf8'));
});
app.get('/clone/:jobId/changes', (req, res) => {
  const p = resolve(CLONE_DIR, req.params.jobId, 'changes.md');
  if (!existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.type('text').send(readFileSync(p, 'utf8'));
});
app.get('/clone/:jobId/analysis', (req, res) => {
  const p = resolve(CLONE_DIR, req.params.jobId, 'ad-analysis.md');
  if (!existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.type('text').send(readFileSync(p, 'utf8'));
});
app.get('/clone/:jobId/original', (req, res) => {
  const p1 = resolve(CLONE_DIR, req.params.jobId, 'original.html');
  const p2 = '/home/hyprads/hyprads/clones/output/original.html';
  const p = existsSync(p1) ? p1 : existsSync(p2) ? p2 : null;
  if (!p) return res.status(404).json({ error: 'No original saved' });
  res.type('html').send(readFileSync(p, 'utf8'));
});
app.get('/clone/:jobId/original.png', (req, res) => {
  // Serve original screenshot — check job dir first, then agent output dir
  const p1 = resolve(CLONE_DIR, req.params.jobId, 'original.png');
  const p2 = '/home/hyprads/hyprads/clones/output/original.png';
  const p = existsSync(p1) ? p1 : existsSync(p2) ? p2 : null;
  if (!p) return res.status(404).json({ error: 'No screenshot' });
  res.type('image/png').send(readFileSync(p));
});

// ─── Non-streaming personalization helper ───
async function runPersonalization(body) {
  const { url, adCreativeUrl, adCreativeText, adCreativeBase64 } = body;
  if (!url) return { error: 'url is required', status: 400 };
  if (!adCreativeUrl && !adCreativeText && !adCreativeBase64) return { error: 'ad creative required', status: 400 };
  try { new URL(url); } catch { return { error: 'Invalid URL', status: 400 }; }

  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = resolve(CLONE_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  let adArg = '';
  if (adCreativeBase64) {
    const imgBuf = Buffer.from(adCreativeBase64, 'base64');
    const imgPath = resolve(jobDir, 'ad-creative.png');
    writeFileSync(imgPath, imgBuf);
    adArg = imgPath;
  } else if (adCreativeUrl) {
    const imgPath = resolve(jobDir, 'ad-creative.png');
    await exec('node', ['scripts/capture-ad.mjs', adCreativeUrl, imgPath], { timeout: 60000, cwd: process.cwd() });
    adArg = imgPath;
  } else {
    adArg = `"${adCreativeText.replace(/"/g, '\\"')}"`;
  }

  const prompt = `/clone-and-personalize ${url} ${adArg}`;
  const { stdout } = await exec('su', ['-', 'hyprads', '-c',
    `cd /home/hyprads/hyprads && claude --dangerously-skip-permissions -p '${prompt.replace(/'/g, "'\\''")}' --allowedTools Read,Write,Edit,Bash,Glob,Grep --output-format json`
  ], { timeout: 600000, cwd: process.cwd() });

  let agentResult;
  try { agentResult = JSON.parse(stdout); } catch { agentResult = { result: stdout }; }

  const agentOutDir = '/home/hyprads/hyprads/clones/output';
  const htmlPath = resolve(agentOutDir, 'index.html');
  const changesPath = resolve(agentOutDir, 'changes.md');
  const analysisPath = resolve(agentOutDir, 'ad-analysis.md');

  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : null;
  const changes = existsSync(changesPath) ? readFileSync(changesPath, 'utf8') : null;
  const analysis = existsSync(analysisPath) ? readFileSync(analysisPath, 'utf8') : null;

  if (html) writeFileSync(resolve(jobDir, 'index.html'), html);
  if (changes) writeFileSync(resolve(jobDir, 'changes.md'), changes);
  if (analysis) writeFileSync(resolve(jobDir, 'ad-analysis.md'), analysis);

  if (!html) return { error: 'Personalization failed', agentResult: agentResult.result, status: 500 };

  return { jobId, url, html, changes, analysis, sizeKB: Math.round(html.length / 1024), cost: agentResult.total_cost_usd || null };
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HyprAds API running on http://0.0.0.0:${PORT}`);
});
server.timeout = 600000;
server.keepAliveTimeout = 610000;
