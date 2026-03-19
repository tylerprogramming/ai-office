const express    = require('express');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const { exec: execCb } = require('child_process');
const { promisify }    = require('util');
const FormData   = require('form-data');
const { getKey, openaiChat } = require('../lib/openai');
const logger     = require('../lib/logger');

const execAsync = promisify(execCb);

const KIE_KEY     = process.env.KIE_API_KEY     || '';
const BLOTATO_KEY = process.env.BLOTATO_API_KEY || '';
const EL_KEY      = process.env.ELEVENLABS_API_KEY || '';

const router = express.Router();

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// POST /api/skill/script — Alex: generate titles, hooks, script outline
router.post('/script', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  logger.skill('script', `start — "${message?.slice(0, 60)}"`);

  const system = `You are Alex, a YouTube Script Writer. Given a video topic or request, generate a complete script package.
Return ONLY valid JSON (no markdown):
{
  "titles": ["title1", "title2", "title3"],
  "hooks": ["hook1 (first 15 seconds)", "hook2", "hook3"],
  "outline": [{"section":"Intro","beats":["beat1","beat2"]},{"section":"Main Point 1","beats":["..."]}],
  "summary": "one-line bubble text for the agent (max 80 chars)",
  "response": "full chat response with all titles, hooks, and outline formatted nicely"
}`;

  try {
    const raw = await openaiChat(key, system, message, 1200);
    const data = JSON.parse(raw.trim());
    logger.skill('script', `done — "${data.summary}"`);
    res.json(data);
  } catch (e) {
    logger.error(`skill/script: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/thumbnail — Sam: generate thumbnail concept (+ Kie.ai if key set)
router.post('/thumbnail', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  logger.skill('thumbnail', `start — "${message?.slice(0, 60)}"`);

  const system = `You are Sam, a YouTube Thumbnail Designer. Given a video concept, generate thumbnail ideas.
Return ONLY valid JSON (no markdown):
{
  "concept": "2-3 sentence thumbnail concept description",
  "prompt": "detailed image generation prompt for the thumbnail",
  "text_overlay": "Bold text for thumbnail overlay (max 5 words)",
  "colors": "Primary color palette recommendation",
  "summary": "one-line bubble text for agent (max 80 chars)",
  "response": "full chat response describing the thumbnail concept, text overlay, colors, and composition"
}`;

  try {
    const raw = await openaiChat(key, system, message, 600);
    const data = JSON.parse(raw.trim());

    if (KIE_KEY && data.prompt) {
      try {
        const kieRes = await fetch('https://api.kie.ai/v1/image/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIE_KEY}` },
          body: JSON.stringify({ model: 'nano-banana-2', prompt: data.prompt, width: 1280, height: 720 }),
          signal: AbortSignal.timeout(30000),
        });
        if (kieRes.ok) {
          const kd = await kieRes.json();
          if (kd.url) {
            data.imageUrl = kd.url;
            data.response += `\n\n🖼️ Generated thumbnail: ${kd.url}`;
          }
        }
      } catch (e) { console.error('Kie.ai error:', e.message); }
    }

    logger.skill('thumbnail', `done — "${data.summary}"`);
    res.json(data);
  } catch (e) {
    logger.error(`skill/thumbnail: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/research — Jordan: web research + fetch docs, first step of pipeline
router.post('/research', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  const slug   = slugify(message);
  const outDir = path.join(os.homedir(), 'yt-research', slug);
  ensureDir(outDir);
  logger.skill('research', `start — "${message?.slice(0, 60)}"`);

  // Step 1: Ask LLM which docs/resource URLs are most relevant to this topic
  let webContent = '';
  try {
    const urlRaw = await openaiChat(key,
      `Return 3 authoritative documentation or resource URLs for the given video topic. No YouTube, no social media.
Return ONLY valid JSON: {"urls": ["https://...", "https://...", "https://..."]}`,
      `Topic: "${message}"`, 150
    );
    const { urls } = JSON.parse(urlRaw.trim());
    logger.skill('research', `fetching ${urls.length} URLs via Jina Reader`);

    // Step 2: Fetch each URL as clean text via Jina Reader (free, no key needed)
    const pages = await Promise.all(
      urls.slice(0, 3).map(async url => {
        try {
          const r = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(12000) });
          if (r.ok) return `### Source: ${url}\n${(await r.text()).slice(0, 2500)}`;
        } catch (e) { logger.error(`fetch ${url}: ${e.message}`); }
        return null;
      })
    );
    webContent = pages.filter(Boolean).join('\n\n---\n\n');
    if (webContent) {
      fs.writeFileSync(path.join(outDir, 'web-research.md'), `# Web Research: ${message}\n\n${webContent}\n`);
      logger.skill('research', `web content saved to ~/yt-research/${slug}/web-research.md`);
    }
  } catch (e) {
    logger.error(`research url-fetch: ${e.message}`);
  }

  // Step 3: LLM synthesizes everything into a research summary
  const context = webContent
    ? `Fetched documentation:\n${webContent.slice(0, 4000)}`
    : '(web fetch unavailable — use your knowledge)';

  const system = `You are Jordan, a YouTube Producer. Synthesize web research into video production insights.
Return ONLY valid JSON:
{
  "topic": "extracted topic",
  "saveIdea": false,
  "ideaEntry": "",
  "trends": ["trend or insight from docs"],
  "opportunities": ["content angle or opportunity"],
  "keyDocs": ["doc title or URL worth referencing in video"],
  "summary": "one-line bubble text (max 80 chars)",
  "response": "2-3 sentences: what you found and what it means for the video"
}`;

  try {
    const raw  = await openaiChat(key, system, `Topic: "${message}"\n\n${context}`, 800);
    const data = JSON.parse(raw.trim());
    const files = webContent ? [`~/yt-research/${slug}/web-research.md`] : [];

    if (data.saveIdea && data.ideaEntry) {
      const ideasPath = path.join(os.homedir(), 'youtube', 'video-ideas.md');
      ensureDir(path.dirname(ideasPath));
      fs.appendFileSync(ideasPath, `\n## ${data.ideaEntry}\n_Added: ${new Date().toISOString().slice(0, 10)}_\n`);
      files.push('~/youtube/video-ideas.md');
    }

    logger.skill('research', `done — "${data.summary}" | files: ${files.join(', ') || 'none'}`);
    res.json({ ...data, files });
  } catch (e) {
    logger.error(`skill/research: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/seo — Casey: SEO-optimized titles, description, tags
router.post('/seo', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  logger.skill('seo', `start — "${message?.slice(0, 60)}"`);

  const system = `You are Casey, a YouTube SEO Specialist. Generate SEO analysis and optimized titles.
Return ONLY valid JSON (no markdown):
{
  "titles": [
    {"title": "title text", "score": 85, "reason": "why this scores well"},
    {"title": "title text", "score": 78, "reason": "..."},
    {"title": "title text", "score": 72, "reason": "..."},
    {"title": "title text", "score": 68, "reason": "..."},
    {"title": "title text", "score": 65, "reason": "..."}
  ],
  "description": "SEO-optimized description (first 150 chars are key)",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13","tag14","tag15"],
  "summary": "one-line bubble text for agent (max 80 chars)",
  "response": "full chat response with title scorecards, description, and tags formatted nicely"
}`;

  try {
    const raw = await openaiChat(key, system, message, 1000);
    const data = JSON.parse(raw.trim());
    logger.skill('seo', `done — "${data.summary}"`);
    res.json(data);
  } catch (e) {
    logger.error(`skill/seo: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/repurpose — Riley: Shorts scripts, LinkedIn, tweets, captions
router.post('/repurpose', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  logger.skill('repurpose', `start — "${message?.slice(0, 60)}"`);

  const system = `You are Riley, a YouTube Content Repurposer. Repurpose the given content into multiple formats.
Return ONLY valid JSON (no markdown):
{
  "shorts": [
    {"title": "Short title", "hook": "opening line", "script": "30-60 second script"},
    {"title": "...", "hook": "...", "script": "..."},
    {"title": "...", "hook": "...", "script": "..."}
  ],
  "linkedin": "LinkedIn post (professional tone, 150-300 words)",
  "tweets": ["tweet1 (max 280 chars)", "tweet2", "tweet3", "tweet4", "tweet5"],
  "instagram": "Instagram caption with hashtags",
  "summary": "one-line bubble text for agent (max 80 chars)",
  "response": "full chat response listing all created pieces with previews"
}`;

  try {
    const raw = await openaiChat(key, system, message, 1500);
    const data = JSON.parse(raw.trim());
    logger.skill('repurpose', `done — "${data.summary}"`);
    res.json(data);
  } catch (e) {
    logger.error(`skill/repurpose: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/post — Casey: format + optionally publish via Blotato
router.post('/post', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  logger.skill('post', `start — "${message?.slice(0, 60)}"`);

  const system = `You are Casey, a YouTube SEO Specialist who also handles social media publishing. Format content for posting.
Return ONLY valid JSON (no markdown):
{
  "platform": "twitter|linkedin|instagram|threads",
  "content": "formatted post content ready to publish",
  "summary": "one-line bubble text for agent (max 80 chars)",
  "response": "full chat response confirming what was posted or formatted"
}`;

  try {
    const raw = await openaiChat(key, system, message, 600);
    const data = JSON.parse(raw.trim());

    if (BLOTATO_KEY && data.platform && data.content) {
      try {
        const postRes = await fetch('https://backend.blotato.com/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'blotato-api-key': BLOTATO_KEY },
          body: JSON.stringify({ text: data.content, platform: data.platform }),
          signal: AbortSignal.timeout(15000),
        });
        if (postRes.ok) {
          data.response += '\n\n✅ Published via Blotato!';
          data.summary = `Posted to ${data.platform}!`;
        }
      } catch (e) { console.error('Blotato error:', e.message); }
    } else if (!BLOTATO_KEY) {
      data.response += '\n\n💡 Add BLOTATO_API_KEY to .env to auto-publish.';
    }

    logger.skill('post', `done — "${data.summary}"`);
    res.json(data);
  } catch (e) {
    logger.error(`skill/post: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ─── YT PRODUCTION PIPELINE ──────────────────────────────────────────────────
// 4-step flow: research → yt-search → transcribe-yt → yt
// Steps share a slug derived from the topic; each writes files the next can read.

// POST /api/skill/yt-search — Riley: find top YouTube videos on a topic
router.post('/yt-search', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  const slug   = slugify(message);
  const outDir = path.join(os.homedir(), 'yt-research', slug);
  ensureDir(outDir);
  logger.skill('yt-search', `start — "${message?.slice(0, 60)}"`);

  // Try real yt-dlp search; fall back to knowledge-based if unavailable
  let videos = [];
  try {
    const { stdout } = await execAsync(
      `yt-dlp --flat-playlist -j "ytsearch15:${message}" 2>/dev/null`,
      { timeout: 45000 }
    );
    videos = stdout.trim().split('\n')
      .filter(line => line.trim().startsWith('{'))
      .map(line => {
        try {
          const v = JSON.parse(line);
          return {
            id:       v.id,
            title:    v.title,
            views:    v.view_count || 0,
            uploader: v.uploader || v.channel || '',
            url:      v.url || `https://www.youtube.com/watch?v=${v.id}`,
          };
        } catch { return null; }
      })
      .filter(v => v?.id && v?.title)
      .sort((a, b) => b.views - a.views)
      .slice(0, 3);
    if (videos.length) fs.writeFileSync(path.join(outDir, 'videos.json'), JSON.stringify(videos, null, 2));
  } catch (e) {
    logger.error(`yt-dlp search: ${e.message}`);
  }

  const videoList = videos.length
    ? videos.map((v, i) => `${i + 1}. "${v.title}" — ${v.uploader} (${Math.round(v.views / 1000)}K views)`).join('\n')
    : '(yt-dlp unavailable — using knowledge-based analysis)';

  const system = `You are Riley, a YouTube Content Repurposer. Analyze top YouTube search results for the given topic.
Return ONLY valid JSON:
{
  "topVideos": ["title — channel, key angle"],
  "patterns": ["what formats/angles are working"],
  "gaps": ["content gap or opportunity"],
  "summary": "one-line bubble text (max 80 chars)",
  "response": "2-3 sentences: what's ranking, what angle is missing"
}`;

  try {
    const raw  = await openaiChat(key, system, `Topic: "${message}"\n\n${videoList}`, 500);
    const data = JSON.parse(raw.trim());

    const report = [
      `# YT Research: ${message}`,
      `\n## Top Videos\n${videoList}`,
      `\n## Patterns\n${(data.patterns || []).map(p => `- ${p}`).join('\n')}`,
      `\n## Gaps\n${(data.gaps || []).map(g => `- ${g}`).join('\n')}`,
      `\n_${new Date().toISOString().slice(0, 10)}_`,
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'report.md'), report);

    const files = [`~/yt-research/${slug}/report.md`];
    logger.skill('yt-search', `done — ${videos.length} videos found → ${files[0]}`);
    res.json({ ...data, files, slug, topUrl: videos[0]?.url || null });
  } catch (e) {
    logger.error(`skill/yt-search: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/transcribe-yt — Alex: download + transcribe the top video
router.post('/transcribe-yt', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  const slug = slugify(message);
  logger.skill('transcribe-yt', `start — "${message?.slice(0, 60)}"`);

  // Read top video URL written by yt-search
  let topUrl = null;
  const videosPath = path.join(os.homedir(), 'yt-research', slug, 'videos.json');
  if (fs.existsSync(videosPath)) {
    try { topUrl = JSON.parse(fs.readFileSync(videosPath, 'utf8'))[0]?.url; } catch {}
  }

  // Download audio via yt-dlp, transcribe via OpenAI Whisper
  let transcript = '';
  const scriptsDir     = path.join(os.homedir(), 'scripts');
  const transcriptPath = path.join(scriptsDir, `transcript_${slug}.txt`);
  ensureDir(scriptsDir);

  if (topUrl) {
    const audioOut = `/tmp/yttranscribe_${slug}.mp3`;
    try {
      await execAsync(
        `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioOut}" "${topUrl}"`,
        { timeout: 120000 }
      );
      logger.skill('transcribe-yt', `audio downloaded: ${audioOut}`);

      const audioBuffer = fs.readFileSync(audioOut);
      if (audioBuffer.length < 25 * 1024 * 1024) {  // OpenAI Whisper 25MB limit
        const form = new FormData();
        form.append('model', 'whisper-1');
        form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg', knownLength: audioBuffer.length });

        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, ...form.getHeaders() },
          body: form.getBuffer(),
          signal: AbortSignal.timeout(120000),
        });
        if (r.ok) {
          transcript = (await r.json()).text || '';
          fs.writeFileSync(transcriptPath, transcript);
          logger.skill('transcribe-yt', `transcript saved: ${transcriptPath}`);
        } else {
          logger.error(`transcribe-yt whisper: ${r.status} ${await r.text()}`);
        }
      } else {
        logger.skill('transcribe-yt', 'audio exceeds 25MB — using knowledge-based analysis');
      }
      try { fs.unlinkSync(audioOut); } catch {}
    } catch (e) {
      logger.error(`transcribe-yt download: ${e.message}`);
    }
  }

  const context = transcript
    ? `Transcript (first 3000 chars):\n${transcript.slice(0, 3000)}`
    : `No transcript available — analyze based on knowledge of: "${message}"`;

  const system = `You are Alex, a YouTube Script Writer. Analyze this video content to extract insights for creating a better competing video.
Return ONLY valid JSON:
{
  "keyPoints": ["main point covered"],
  "hooks": ["opening hook or angle used"],
  "structure": "how they structured the video in one sentence",
  "gaps": ["what they missed or could improve"],
  "summary": "one-line bubble text (max 80 chars)",
  "response": "2-3 sentences: what worked, what to do differently"
}`;

  try {
    const raw  = await openaiChat(key, system, `Topic: "${message}"\n\n${context}`, 600);
    const data = JSON.parse(raw.trim());
    const files = transcript ? [`~/scripts/transcript_${slug}.txt`] : [];
    logger.skill('transcribe-yt', `done — ${transcript ? 'real transcript' : 'knowledge-based'}`);
    res.json({ ...data, files });
  } catch (e) {
    logger.error(`skill/transcribe-yt: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skill/yt — Casey: create full video production package + save files
router.post('/yt', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  const slug    = slugify(message);
  const homeDir = os.homedir();
  logger.skill('yt', `start — "${message?.slice(0, 60)}"`);

  // Gather context written by previous pipeline steps
  const contextParts = [];
  const reportPath     = path.join(homeDir, 'yt-research', slug, 'report.md');
  const transcriptPath = path.join(homeDir, 'scripts', `transcript_${slug}.txt`);
  if (fs.existsSync(reportPath))     contextParts.push(`## YT Research\n${fs.readFileSync(reportPath, 'utf8').slice(0, 1500)}`);
  if (fs.existsSync(transcriptPath)) contextParts.push(`## Transcript Insights\n${fs.readFileSync(transcriptPath, 'utf8').slice(0, 2000)}`);
  const context = contextParts.join('\n\n') || '(no prior research — generating from topic knowledge)';

  const system = `You are Casey, a YouTube SEO Specialist. Create a complete video production package.
Return ONLY valid JSON:
{
  "analysis": "2-3 paragraphs: topic overview, target audience, competitive landscape",
  "titles": ["best SEO title", "alt title 2", "alt title 3"],
  "hooks": ["hook 1 (first 15s script)", "hook 2", "hook 3"],
  "outline": [{"section": "Intro", "beats": ["beat 1", "beat 2"]}, {"section": "Main", "beats": ["..."]}],
  "description": "SEO-optimized YouTube description (150-300 words with keywords)",
  "filmingGuide": "practical guide: setup, b-roll suggestions, pacing tips (2-3 paragraphs)",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10"],
  "summary": "one-line bubble text (max 80 chars)",
  "response": "brief confirmation of what was created"
}`;

  try {
    const raw  = await openaiChat(key, system, `Topic: "${message}"\n\n${context}`, 2000);
    const data = JSON.parse(raw.trim());

    // Save all files to ~/youtube/<slug>/
    const outDir = path.join(homeDir, 'youtube', slug);
    ensureDir(outDir);

    const fileContents = {
      'analysis.md':      `# Analysis: ${message}\n\n${data.analysis}\n`,
      'titles.md':        `# Titles\n\n${data.titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`,
      'hooks.md':         `# Hooks\n\n${data.hooks.map((h, i) => `**Hook ${i + 1}:** ${h}`).join('\n\n')}\n`,
      'script.md':        `# Script Outline: ${message}\n\n${data.outline.map(s => `## ${s.section}\n${s.beats.map(b => `- ${b}`).join('\n')}`).join('\n\n')}\n`,
      'description.md':  `# Description\n\n${data.description}\n\n## Tags\n${data.tags.join(', ')}\n`,
      'filming-guide.md': `# Filming Guide\n\n${data.filmingGuide}\n`,
    };

    const files = [];
    for (const [name, content] of Object.entries(fileContents)) {
      fs.writeFileSync(path.join(outDir, name), content);
      files.push(`~/youtube/${slug}/${name}`);
    }

    logger.skill('yt', `done — ${files.length} files saved to ~/youtube/${slug}/`);
    res.json({ ...data, files });
  } catch (e) {
    logger.error(`skill/yt: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;
