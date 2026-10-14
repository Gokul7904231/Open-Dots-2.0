import http from 'node:http';

const PORT = 4315;

const RADOX_KEY = (process.env.RADOX_API_KEY || '').trim();
const RADOX_BASE = (process.env.RADOX_BASE_URL || 'https://radoxai.com/v1').replace(/\/$/, '');

const NVIDIA_KEY = (process.env.NVIDIA_API_KEY || '').trim();
const NVIDIA_BASE = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');

const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

// ============================================================================
// CATEGORY 1: PRIMARY — BEST INTELLIGENCE MODELS
// Top 2 Primary Flagships + Deep Frontier Backups
// ============================================================================
const PRIMARY_BEST_MODELS = [
  // --- TOP 2 PRIMARY FLAGSHIPS ---
  { provider: 'radox', model: process.env.RADOX_BEST_MODEL || 'claude-opus-5.5', role: 'Primary-Best-1' },
  { provider: 'nvidia', model: process.env.NVIDIA_BEST_MODEL || 'z-ai/glm-5.3', role: 'Primary-Best-2' },

  // --- DEEP FRONTIER BACKUPS ---
  { provider: 'radox', model: 'claude-fable-5.1', role: 'Best-Backup' },
  { provider: 'nvidia', model: 'moonshotai/kimi-k3', role: 'Best-Backup' },
  { provider: 'radox', model: 'gpt-5.6-sol', role: 'Best-Backup' },
  { provider: 'radox', model: 'deepseek-v4-pro-max', role: 'Best-Backup' },
  { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', role: 'Best-Backup' },
  { provider: 'radox', model: 'gemini-3.1-pro', role: 'Best-Backup' },
];

// ============================================================================
// CATEGORY 2: SECONDARY — FAST / LOW-LATENCY MODELS
// Used for instant voice/chat turns AND as high-speed fallback for Category 1
// ============================================================================
const SECONDARY_FAST_MODELS = [
  { provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', role: 'Secondary-Fast-1' },
  { provider: 'radox', model: process.env.RADOX_FAST_MODEL || 'gpt-5.6-luna', role: 'Secondary-Fast-2' },
  { provider: 'nvidia', model: process.env.NVIDIA_FAST_MODEL || 'z-ai/glm-5.3-flash', role: 'Secondary-Fast' },
  { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash', role: 'Secondary-Fast' },
  { provider: 'radox', model: 'gemini-3.7-flash', role: 'Secondary-Fast' },
  { provider: 'radox', model: 'claude-sonnet-5', role: 'Secondary-Fast' },
  { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', role: 'Secondary-Fast' },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', role: 'Secondary-Fallback' },
];

const liveCatalog = { radox: new Set(), nvidia: new Set(), openrouter: new Set() };
const modelHealth = new Map(); // Key: "provider:model" -> { cooldownUntil, lastError }
const COOLDOWN_MS = 60_000;    // 60s circuit breaker when an endpoint fails

function getProviderConfig(provider) {
  if (provider === 'radox' && RADOX_KEY) return { base: RADOX_BASE, key: RADOX_KEY, name: 'RadoxAI' };
  if (provider === 'nvidia' && NVIDIA_KEY) return { base: NVIDIA_BASE, key: NVIDIA_KEY, name: 'NVIDIA-NIM' };
  if (provider === 'openrouter' && OPENROUTER_KEY) return { base: OPENROUTER_BASE, key: OPENROUTER_KEY, name: 'OpenRouter' };
  return null;
}

async function syncCatalogs() {
  for (const p of ['radox', 'nvidia']) {
    const cfg = getProviderConfig(p);
    if (!cfg) continue;
    try {
      const res = await fetch(`${cfg.base}/models`, {
        headers: { Authorization: `Bearer ${cfg.key}` },
      });
      if (res.ok) {
        const json = await res.json();
        const ids = (json.data || []).map((m) => m.id);
        liveCatalog[p] = new Set(ids);
        console.log(`[SmartRouter] Synced ${ids.length} live models from ${cfg.name}`);
      }
    } catch (err) {
      console.warn(`[SmartRouter] Could not sync ${cfg.name} catalog: ${err.message}`);
    }
  }
}

function resolveModelId(provider, requestedId) {
  const catalog = liveCatalog[provider];
  if (!catalog || catalog.size === 0 || catalog.has(requestedId)) return requestedId;

  const slug = requestedId.split('/').pop().replace(/[.-]/g, '').toLowerCase();
  for (const id of catalog) {
    const candidateSlug = id.split('/').pop().replace(/[.-]/g, '').toLowerCase();
    if (candidateSlug === slug) return id;
  }
  return requestedId;
}

function isHealthy(provider, model) {
  const state = modelHealth.get(`${provider}:${model}`);
  if (!state) return true;
  return Date.now() >= state.cooldownUntil;
}

function markFailure(provider, model, reason) {
  modelHealth.set(`${provider}:${model}`, {
    cooldownUntil: Date.now() + COOLDOWN_MS,
    lastError: reason,
  });
}

function classifyTurn(payload) {
  const messages = payload.messages || [];
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const text = typeof lastUserMsg === 'string' ? lastUserMsg : JSON.stringify(lastUserMsg);

  // If payload contains tool definitions or tool_choice, it requires tool calling / agent execution
  const hasTools = Boolean(payload.tools && payload.tools.length > 0) || Boolean(payload.tool_choice);

  // Use Primary Best models for complex reasoning, coding, multi-turn context, workspace creation, or tools
  const isComplex =
    hasTools ||
    text.length > 160 ||
    messages.length > 8 ||
    /```/.test(text) ||
    /\b(analyze|research|draft|write|page|code|plan|compare|detailed|summary|report|schedule|create|build|architecture|review|debug|explain|strategy)\b/i.test(
      text
    );

  return isComplex ? 'PRIMARY_BEST' : 'SECONDARY_FAST';
}

function buildExecutionPlan(tier) {
  // Primary Best cascades into Secondary Fast if all Primary models are busy;
  // Secondary Fast cascades into Primary Best if all Fast models are busy.
  const ordered =
    tier === 'PRIMARY_BEST'
      ? [...PRIMARY_BEST_MODELS, ...SECONDARY_FAST_MODELS]
      : [...SECONDARY_FAST_MODELS, ...PRIMARY_BEST_MODELS];

  // Put healthy (non-cooldown) models first, keeping cooldown models only as last-resort
  const healthy = [];
  const cooling = [];
  for (const item of ordered) {
    const resolved = resolveModelId(item.provider, item.model);
    const entry = { ...item, model: resolved };
    if (isHealthy(item.provider, resolved)) {
      healthy.push(entry);
    } else {
      cooling.push(entry);
    }
  }
  return [...healthy, ...cooling];
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    const combined = [];
    for (const p of ['radox', 'nvidia']) {
      const cfg = getProviderConfig(p);
      if (!cfg) continue;
      try {
        const r = await fetch(`${cfg.base}/models`, {
          headers: { Authorization: `Bearer ${cfg.key}` },
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.data)) combined.push(...j.data);
        }
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: combined }));
    return;
  }

  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = '';
    for await (const chunk of req) body += chunk;

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
      return;
    }

    const tier = classifyTurn(payload);
    const plan = buildExecutionPlan(tier);

    for (const target of plan.slice(0, 6)) {
      const cfg = getProviderConfig(target.provider);
      if (!cfg) continue;

      const startTime = Date.now();
      const timeoutMs = payload.stream ? 15000 : 25000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const reqBody = { ...payload, model: target.model };
        console.log(
          `[SmartRouter] [${tier}] (${target.role}) -> [${cfg.name}] ${target.model}`
        );

        const upstream = await fetch(`${cfg.base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if ([400, 401, 403, 404, 422, 429, 500, 502, 503, 504].includes(upstream.status)) {
          const errText = await upstream.text().catch(() => '');
          console.warn(
            `[SmartRouter] [${cfg.name}] ${target.model} HTTP ${upstream.status} (${errText.slice(0, 90)}) -> 60s cooldown`
          );
          markFailure(target.provider, target.model, `HTTP ${upstream.status}`);
          continue;
        }

        console.log(
          `[SmartRouter] Connected [${cfg.name}] ${target.model} in ${Date.now() - startTime}ms`
        );

        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        });

        if (upstream.body) {
          for await (const chunk of upstream.body) res.write(chunk);
        }
        res.end();
        return;
      } catch (err) {
        clearTimeout(timer);
        console.warn(
          `[SmartRouter] [${cfg.name}] ${target.model} failed (${err.message}) -> 60s cooldown`
        );
        markFailure(target.provider, target.model, err.message);
      }
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'All Primary and Secondary models failed.' } }));
    return;
  }

  res.writeHead(404).end();
});

await syncCatalogs();
setInterval(syncCatalogs, 5 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[*] Dual-Tier Smart Router (Primary Best + Secondary Fast) active at http://127.0.0.1:${PORT}/v1`);
});
