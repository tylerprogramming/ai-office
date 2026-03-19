const express  = require('express');
const { getKey } = require('../lib/openai');
const logger   = require('../lib/logger');
const router   = express.Router();

const PLANNER_SYSTEM = `You are the Director of a YouTube content production team. Route user messages to the right agent(s).

AGENTS AND SKILLS:
- jordan (Producer):           research, chat — web trend research, saves video ideas
- riley  (Content Repurposer): yt-search, repurpose, chat — searches YouTube for top videos on a topic
- alex   (Script Writer):      transcribe-yt, script, chat — transcribes/analyzes competing videos, writes scripts
- casey  (SEO Specialist):     yt, seo, post, chat — creates full video packages, SEO, social publishing
- sam    (Thumbnail Designer): thumbnail, chat — thumbnail concepts and image generation
- max    (Fitness Coach):      fitness, chat — workout logging, nutrition, fitness progress

ROUTING RULES:
1. "create/make/plan/write a video about X" → 4-step pipeline, extract topic as "input" for all steps:
   [{jordan,research,X}, {riley,yt-search,X}, {alex,transcribe-yt,X}, {casey,yt,X}]
2. "script / hook / outline" only → [{alex, script, message}]
3. "thumbnail" → [{sam, thumbnail, message}]
4. "SEO / optimize title / tags / keywords / CTR" → [{casey, seo, message}]
5. "repurpose / shorts / clips / reels" → [{riley, repurpose, message}]
6. "post to / publish / share on / tweet" → [{casey, post, message}]
7. fitness / food / workout / calories / protein → [{max, fitness, message}]
8. Agent name + work request → [{that_agent, relevant_skill, message}]
9. Agent name + question → [{that_agent, chat, message}]
10. General/ambiguous → most relevant agent with chat

For rule 1: set directorMessage summarizing the 4-step plan (e.g. "On it! Jordan researches, Riley searches YT, Alex transcribes, Casey builds the package.").
For all other rules: directorMessage is null.

Respond ONLY with valid JSON:
{"directorMessage": null, "steps": [{"agent": "agent_id", "skill": "skill_name", "input": "..."}]}`;

router.post('/plan', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(401).json({ error: 'No API key' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  logger.plan(`routing — "${message?.slice(0, 60)}"`);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_completion_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PLANNER_SYSTEM },
          { role: 'user',   content: message },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const plan = JSON.parse((await r.json()).choices[0].message.content);
    logger.plan(`→ ${plan.steps.map(s => `${s.agent}:${s.skill}`).join(' → ')}`);
    res.json(plan);
  } catch (e) {
    logger.error(`plan: ${e.message}`);
    // Safe fallback — never leave the client hanging
    res.json({ directorMessage: null, steps: [{ agent: 'jordan', skill: 'chat', input: message }] });
  }
});

module.exports = router;
