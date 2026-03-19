const express  = require('express');
const multer   = require('multer');
const FormData = require('form-data');
const { getKey, setMemKey, MODEL } = require('../lib/openai');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';

// One-time key setup from browser (stored in memory only, never on disk)
router.post('/setkey', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-')) return res.status(400).json({ error: 'Invalid key format' });
  setMemKey(key);
  console.log('✅  API key set via browser (in-memory)');
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ ok: true, keyLoaded: !!getKey() });
});

router.post('/chat', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key. Use /api/setkey or set OPENAI_API_KEY in .env' });

  const { system, user, maxTokens = 250 } = req.body;
  if (!system || !user) return res.status(400).json({ error: 'Missing system or user' });

  try {
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

router.post('/transcribe', upload.single('audio'), async (req, res) => {
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

module.exports = router;
