require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname)));

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

// Key priority: .env → in-memory (set via /api/setkey)
let ENV_KEY = process.env.OPENAI_API_KEY || '';
let MEM_KEY = '';
const getKey = () => ENV_KEY || MEM_KEY;

// One-time key setup from browser (stored in memory only, never on disk)
app.post('/api/setkey', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-') || key.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Expected an OpenAI API key (sk-...); Anthropic keys (sk-ant-...) do not work here' });
  }
  MEM_KEY = key;
  console.log('✅  API key set via browser (in-memory)');
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ ok: true, keyLoaded: !!getKey() });
});

app.post('/api/chat', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key. Use /api/setkey or set OPENAI_API_KEY in .env' });

  const { system, user, maxTokens = 250 } = req.body;
  if (!system || !user) return res.status(400).json({ error: 'Missing system or user' });

  try {
    // Reasoning models (o-series, gpt-5-*) burn tokens on internal chain-of-thought
    // before producing output — give them a larger budget so content isn't empty.
    const tokenBudget = /^o\d|gpt-5/.test(MODEL)
      ? Math.max(maxTokens * 12, 2000)
      : maxTokens;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: tokenBudget,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('OpenAI error:', r.status, err.slice(0, 200));
      return res.status(r.status).json({ error: `OpenAI API error ${r.status}: ${err}` });
    }

    const data = await r.json();
    res.json({ text: data.choices[0].message.content });
  } catch (e) {
    console.error('Server error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ELEVENLABS STT ─────────────────────────────────────────────────────────
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!EL_KEY) return res.status(401).json({ error: 'No ELEVENLABS_API_KEY in .env' });
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  try {
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('file', req.file.buffer, {
      filename: 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm',
      knownLength: req.file.buffer.length,
    });

    // getBuffer() is synchronous — avoids stream/undici compatibility issues
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, ...form.getHeaders() },
      body: form.getBuffer(),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('ElevenLabs STT error:', r.status, err.slice(0, 200));
      return res.status(r.status).json({ error: `STT error ${r.status}: ${err}` });
    }

    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (e) {
    console.error('Transcribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ────────────────────────────────────────────────────────────────────────────

// ─── FITNESS API PROXY ──────────────────────────────────────────────────────
const FITNESS_URL = 'http://localhost:3001';

async function fitnessFetch(path, opts = {}) {
  const r = await fetch(`${FITNESS_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Fitness API ${r.status}`);
  return r.json();
}

app.get('/api/fitness/status', async (req, res) => {
  try { await fitnessFetch('/api/health'); res.json({ online: true }); }
  catch { res.json({ online: false }); }
});

app.get('/api/fitness/today', async (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  try { res.json(await fitnessFetch(`/api/activity/${date}`)); }
  catch { res.json(null); }
});

app.get('/api/fitness/week', async (req, res) => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    return d.toISOString().slice(0, 10);
  });
  const activities = await Promise.all(days.map(async date => {
    try { return { date, ...(await fitnessFetch(`/api/activity/${date}`)) }; }
    catch { return { date }; }
  }));
  res.json(activities);
});

// Parse user message with LLM, merge with today's data, log to fitness API
app.post('/api/fitness/action', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });

  const { message } = req.body;
  const today = new Date().toISOString().slice(0, 10);

  // Determine target date (handles "yesterday", "last night", specific dates)
  // LLM will set this in the response; default to today
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // Fetch today's data + nutrition DB in parallel
  let todayData = null, nutritionDb = [];
  await Promise.all([
    fitnessFetch(`/api/activity/${today}`).then(d => todayData = d).catch(() => {}),
    fitnessFetch('/api/nutrition').then(d => nutritionDb = Array.isArray(d) ? d : []).catch(() => {}),
  ]);

  const system = `You are Max, an energetic fitness coach AI. Today is ${today} (yesterday was ${yesterdayStr}).

TODAY'S LOGGED DATA:
${JSON.stringify(todayData || null)}

NUTRITION DATABASE (saved foods with exact macros):
${nutritionDb.length ? nutritionDb.map(n => `- ${n.name}: ${n.calories}cal, ${n.protein}g protein, ${n.fat}g fat, ${n.carbs}g carbs (serving: ${n.serving_size || '1 serving'})`).join('\n') : '(empty)'}

You can do everything the fitness CLI can do:
- Log workouts: weights (lifting, strength, chest day, shoulder day, etc.), running/cardio
- Log food/nutrition: check the DB above first, use those exact values. If not in DB, estimate from common knowledge.
- Multi-day: if user says "yesterday" or "last night", use date ${yesterdayStr} in the log
- Show the fitness grid (opens the web app)
- Check progress: report what's been logged today (calories, protein, workouts, notes)
- Add a new food to the nutrition DB (set addNutrition with the item)
- Update meal plan
- Answer general fitness questions

Notes format: "Workout Type | Exercise: sets/reps | Nutrition: ~Xcal, Xg protein, Xg fat, Xg carbs (items)"
Multiple uses accumulate — always merge with existing data, never overwrite.

Respond ONLY with valid JSON — no markdown, no extra text:
{
  "intent": "log_workout|log_food|show_grid|check_progress|add_nutrition|chat",
  "shouldLog": false,
  "log": {
    "date": "${today}",
    "weights": false,
    "running": false,
    "ateWell": false,
    "notes": "",
    "calories": 0,
    "protein": 0,
    "fat": 0,
    "carbs": 0
  },
  "addNutrition": null,
  "openGrid": false,
  "response": "Max's reply — concise, energetic, use fitness emoji. For check_progress: include actual numbers from the logged data. No character limit."
}

Rules:
- NEVER say "no logs" or "nothing logged" if today's data above is non-null
- For check_progress/queries: read the logged data carefully. Report calories, protein, workouts, notes. Be specific.
- For food logging: check DB first. If found, use exact DB values. If new food, estimate macros and set addNutrition to save it.
- addNutrition format: {"name":"Food Name","serving_size":"1 serving","calories":0,"protein":0,"fat":0,"carbs":0,"sodium":0,"fiber":0,"sugar":0}
- For "yesterday"/"last night": set log.date to ${yesterdayStr}
- For workouts: weights=true for any strength/lifting, running=true for cardio/run
- ateWell=true if user mentions eating well or healthy meals
- openGrid=true + shouldLog=false for "show grid/tracker/app"`;

  try {
    const tokenBudget = /^o\d|gpt-5/.test(MODEL) ? 5000 : 800;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: tokenBudget,
        messages: [{ role: 'system', content: system }, { role: 'user', content: message }],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const aiData = await r.json();
    const parsed = JSON.parse(aiData.choices[0].message.content.trim());

    // Fetch existing data for the target date (may differ from today if "yesterday")
    const targetDate = parsed.log?.date || today;
    let targetData = todayData;
    if (targetDate !== today) {
      try { targetData = await fitnessFetch(`/api/activity/${targetDate}`); } catch { targetData = null; }
    }

    let logged = false;
    if (parsed.shouldLog && parsed.log) {
      const merged = {
        ...parsed.log,
        weights:  (targetData?.weights  || false) || parsed.log.weights,
        running:  (targetData?.running  || false) || parsed.log.running,
        ateWell:  (targetData?.ateWell  || false) || parsed.log.ateWell,
        calories: (targetData?.calories || 0) + (parsed.log.calories || 0),
        protein:  (targetData?.protein  || 0) + (parsed.log.protein  || 0),
        fat:      (targetData?.fat      || 0) + (parsed.log.fat      || 0),
        carbs:    (targetData?.carbs    || 0) + (parsed.log.carbs    || 0),
      };
      if (targetData?.notes && parsed.log.notes) {
        merged.notes = targetData.notes + ' | ' + parsed.log.notes;
      } else {
        merged.notes = parsed.log.notes || targetData?.notes || '';
      }
      try {
        await fitnessFetch('/api/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        });
        logged = true;
      } catch (e) { console.error('Fitness log error:', e.message); }
    }

    // Add new food to nutrition DB if requested
    if (parsed.addNutrition) {
      try {
        await fitnessFetch('/api/nutrition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.addNutrition),
        });
        console.log('✅ Added to nutrition DB:', parsed.addNutrition.name);
      } catch (e) { console.error('Nutrition DB add error:', e.message); }
    }

    res.json({ ...parsed, logged, targetDate });
  } catch (e) {
    console.error('Fitness action error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏢  Agent Office → http://localhost:${PORT}`);
  if (!getKey()) {
    console.log('💡  No API key in .env — enter it in the browser on first load\n');
  } else {
    console.log('✅  API key loaded from .env\n');
  }
});
