# AI Agent Office

A canvas simulation of an office of AI agents who take tasks, hold standups and
chat. `index.html` is the whole front end. `server.js` (Express) serves it and
proxies LLM calls to OpenAI Chat Completions.

## Run

Requires Node 18+.

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY
npm start              # http://localhost:3000
```

If `.env` has no key, the page asks for one on first load. That key is kept in
server memory only. It must be an **OpenAI** key (`sk-...`); Anthropic keys
are rejected.

## Environment

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | Required. Used for every agent message (`/api/chat`). |
| `OPENAI_MODEL` | Optional, default `gpt-5.4-mini`. |
| `ELEVENLABS_API_KEY` | Optional. Voice input via ElevenLabs speech-to-text (`/api/transcribe`). |
| `PORT` | Optional, default `3000`. |

## Optional fitness panel

The fitness panel and the "Max" coach (`/api/fitness/*`) proxy to a separate
fitness API at `http://localhost:3001`. Without it, the panel shows offline and
the rest of the office works normally.
