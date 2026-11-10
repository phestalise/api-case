// api/_lib/ratelimit.js
// Rate limit por IP com Upstash Redis (janela deslizante de 1 minuto).
// Aceita UPSTASH_REDIS_REST_URL/_TOKEN ou KV_REST_API_URL/_TOKEN (nomes que a
// integração Upstash do Vercel cria). Sem nenhum dos dois NÃO bloqueia nada:
// só loga um aviso (uma vez por instância) e deixa a requisição passar.
const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");

let redis;
let avisou = false;
const limitadores = {};

function obterRedis() {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

function obterIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  return xff.split(",")[0].trim() || req.socket?.remoteAddress || "desconhecido";
}

// Devolve true se a requisição pode seguir. Se estourou, já responde 429.
async function aplicarRateLimit(req, res, nome, limitePorMinuto) {
  const r = obterRedis();
  if (!r) {
    if (!avisou) {
      console.warn("Rate limit desativado: variáveis do Upstash (UPSTASH_REDIS_REST_* ou KV_REST_API_*) não configuradas.");
      avisou = true;
    }
    return true;
  }

  if (!limitadores[nome]) {
    limitadores[nome] = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(limitePorMinuto, "1 m"),
      prefix: `rl:${nome}`
    });
  }

  try {
    const { success } = await limitadores[nome].limit(obterIp(req));
    if (!success) {
      res.status(429).json({ error: "Muitas tentativas. Aguarde um minuto." });
      return false;
    }
  } catch (err) {
    // Redis fora do ar não pode derrubar a loja: deixa passar e loga.
    console.warn("Falha no rate limit (liberando a requisição):", err.message);
  }
  return true;
}

module.exports = { aplicarRateLimit };
