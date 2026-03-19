require('dotenv').config();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
let ENV_KEY = process.env.OPENAI_API_KEY || '';
let MEM_KEY = '';
const getKey    = () => ENV_KEY || MEM_KEY;
const setMemKey = (k) => { MEM_KEY = k; };

async function openaiChat(key, system, user, maxTokens = 800) {
  const tokenBudget = /^o\d|gpt-5/.test(MODEL) ? Math.max(maxTokens * 12, 2000) : maxTokens;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL, max_completion_tokens: tokenBudget,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  return (await r.json()).choices[0].message.content;
}

module.exports = { MODEL, getKey, setMemKey, openaiChat };
