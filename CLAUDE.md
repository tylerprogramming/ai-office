# AI Agent Office — CLAUDE.md

## Project Overview

A real-time 3D office simulation where AI agents autonomously move, work, chat, and collaborate. Built with Three.js (WebGL), Express, OpenAI, and ElevenLabs. Agents are powered by GPT and respond to natural language via chat or voice.

## Stack

- **Frontend**: Vanilla JS + Three.js (CDN importmap, ES module), CSS2DRenderer for labels/bubbles
- **Backend**: Node.js + Express (`server.js`)
- **AI**: OpenAI chat completions API (proxied through Express — key never in browser)
- **Voice STT**: ElevenLabs Scribe v1 (`/api/transcribe` endpoint)
- **Fitness**: Proxied to local fitness app at `http://localhost:3001`

## Running

```bash
npm start          # production
npm run dev        # node --watch (auto-restart)
```

Server runs at `http://localhost:3000`. Requires `.env` (see `.env.example`).

## Environment Variables

```
OPENAI_API_KEY=       # Required — OpenAI key
OPENAI_MODEL=         # Default: gpt-4o-mini (supports gpt-5-* reasoning models)
ELEVENLABS_API_KEY=   # Required for voice STT
PORT=                 # Default: 3000
```

## Architecture

### `server.js`
All AI calls are proxied through Express — the browser never holds an API key.

| Endpoint | Description |
|----------|-------------|
| `POST /api/chat` | Proxies to OpenAI chat completions. Handles reasoning model token budget (`gpt-5-*` gets 12× budget) |
| `POST /api/transcribe` | Proxies audio to ElevenLabs Scribe STT. Accepts multipart `audio` field, returns `{ text }` |
| `POST /api/setkey` | Sets OpenAI key in memory (fallback if no .env) |
| `GET /api/status` | Health check + key loaded status |
| `GET /api/fitness/status` | Checks if fitness app is running at localhost:3001 |
| `GET /api/fitness/today` | Today's activity from fitness app |
| `GET /api/fitness/week` | Last 7 days of activity |
| `POST /api/fitness/action` | LLM parses fitness message → merges with today's data → logs to fitness app |

### `index.html`
Single-file frontend (~2300 lines). Key sections:

**Three.js Scene**
- `setupThree()` — renderer, camera (PerspectiveCamera 50°), OrbitControls, lighting
- `buildOffice()` → `buildFloor()`, `buildWalls()`, `buildFurniture()`
- `buildAgents()` — creates Agent instances + 3D mesh groups
- `buildAgentMesh(agent)` — capsule body + sphere head + CSS2DObject labels + speech bubble divs
- `updateAgentMesh(agent, t)` — syncs 3D position from tile coords, animates orbiters when busy
- `simLoop(t)` — main requestAnimationFrame loop

**Coordinate System**
- Grid: 22×15 tiles, `TILE_SIZE = 2.0` world units
- `tileToWorld(tx, ty)` converts tile coords → Three.js world XZ position
- Agents store float tile positions (`agent.x`, `agent.y`) that lerp toward integer targets (`agent.tx`, `agent.ty`)
- `AGENT_SPEED = 2.0` tiles/second

**Agent System**
- `AGENT_DEFS` — 6 agents: Alex (Engineer), Sam (Designer), Jordan (PM), Casey (DevOps), Riley (QA), Max (Fitness Coach)
- `LOCS` — named locations with tile coords (desks, meeting room, gym, lounge, etc.)
- `Agent` class — handles movement lerp, timers, memory array (last 12 events)
- Autonomous think timer fires every 15–20s → `agentThink()` → LLM returns JSON action (move/say/work)
- Task work timer fires every 25–35s after task assigned → `doTaskWork()` → 4 progressive updates then done

**Chat Routing (`sendMsg`)**
Priority order:
1. `/standup`, `/break`, `/focus` — slash commands
2. `FITNESS_RE` regex match → routes to Max's `handleFitnessMessage()`
3. Agent name anywhere in message (primary: name at start; fallback: name anywhere) → direct agent reply
4. `TASK_RE` keyword match → `createTask()` with auto-assigned agent
5. Fallback → random agent responds

**Fitness Integration**
- `handleFitnessMessage()` → `POST /api/fitness/action` → LLM parses intent → logs to fitness API
- Server fetches nutrition DB on every action so Max knows what foods are saved
- Multi-day support: "yesterday" routes to correct date
- Auto-saves new foods to nutrition DB
- Intents: `log_workout`, `log_food`, `check_progress`, `show_grid`, `add_nutrition`, `chat`

**Voice Input**
- Floating mic button (bottom-center) — hold to record, release to transcribe
- `startVoice()` — MediaRecorder captures audio/webm
- `stopVoice()` — POSTs blob to `/api/transcribe` → ElevenLabs Scribe → text → `sendMsg()`
- States: idle (purple) → recording (red + ripple rings) → transcribing (blue spinner)

**Speech Bubbles**
- CSS2DObject divs attached to each agent's Three.js group at `y=2.3`
- `addBubble(agentId, text, durationMs)` sets `display: block` on the div
- Game loop filters expired bubbles and hides their divs
- **Important**: `labelRenderer.domElement` must NOT have `overflow: hidden` — this was a bug that prevented bubbles from showing

**Reasoning Model Compatibility**
Models matching `/^o\d|gpt-5/` get a 12× token budget multiplier because they spend tokens on internal chain-of-thought before producing output. Always use `max_completion_tokens` (not `max_tokens`) for OpenAI.

## Known Gotchas

- `form-data` npm package returns a Readable stream — use `form.getBuffer()` (synchronous) instead of piping, since Node's native `fetch` (undici) can't stream it directly
- CSS2DRenderer's domElement must not share an `id` with any CSS rule that sets `overflow: hidden`
- `MediaRecorder` on macOS prefers `audio/webm;codecs=opus` — always check `isTypeSupported` before setting mimeType
- Reasoning models (`gpt-5-*`, `o-series`) return empty content if token budget is too small — multiply by 12× minimum

## Agent Personalities

| Agent | Role | Personality |
|-------|------|-------------|
| Alex | Engineer | Methodical, loves clean code and documentation |
| Sam | Designer | Creative, user-focused, thinks about aesthetics |
| Jordan | PM | Organized, keeps team aligned on goals |
| Casey | DevOps | Pragmatic, automates everything |
| Riley | QA | Thorough, finds edge cases nobody else thinks of |
| Max | Fitness Coach | Energetic, obsessed with gains, uses fitness emojis |

## Fitness Skill Integration

Max is connected to a local fitness app (`~/fitness-app/`) running at `http://localhost:3001`. The fitness SKILL.md at `~/.claude/skills/fitness/SKILL.md` documents all capabilities. Max can:
- Log workouts (weights, running) and food with macro tracking
- Query and update the nutrition DB
- Handle multi-day entries ("yesterday")
- Show the 7-day GitHub-style activity grid

Start the fitness app: `cd ~/fitness-app && bun run dev`
