// api/frete.js
const axios = require("axios");
const { aplicarRateLimit } = require("./_lib/ratelimit");

// Limites "razoáveis" (Correios/SuperFrete): até 30 kg e 100 cm por lado.
const PESO_MAX_KG = 30;
const DIMENSAO_MAX_CM = 100;

function numeroNoIntervalo(valor, max) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://cases-estalise.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!(await aplicarRateLimit(req, res, "frete", 30))) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  try {
    const token = process.env.SUPERFRETE_TOKEN;
    const baseUrl = process.env.SUPERFRETE_BASE_URL; // ex: https://sandbox.superfrete.com
    const cepOrigem = process.env.CEP_ORIGEM;

    if (!token || !baseUrl || !cepOrigem) {
      console.error("Variaveis de ambiente ausentes.", {
        temToken: !!token,
        temBaseUrl: !!baseUrl,
        temCepOrigem: !!cepOrigem,
      });
      return res.status(500).json({ error: "Configuracao do servidor incompleta." });
    }

    const { cepDestino, peso, altura, largura, comprimento, valorDeclarado } = req.body || {};

    const cep = String(cepDestino || "").replace(/\D/g, "");
    if (cep.length !== 8) {
      return res.status(400).json({ error: "CEP de destino invalido." });
    }

    const pesoKg = numeroNoIntervalo(peso, PESO_MAX_KG);
    const alturaCm = numeroNoIntervalo(altura, DIMENSAO_MAX_CM);
    const larguraCm = numeroNoIntervalo(largura, DIMENSAO_MAX_CM);
    const comprimentoCm = numeroNoIntervalo(comprimento, DIMENSAO_MAX_CM);

    if (!pesoKg || !alturaCm || !larguraCm || !comprimentoCm) {
      return res.status(400).json({ error: "Peso ou dimensoes do pacote invalidos." });
    }

    const seguro = Math.max(0, Number(valorDeclarado) || 0);

    const response = await axios.post(
      baseUrl + "/api/v0/calculator",
      {
        from: { postal_code: cepOrigem },
        to: { postal_code: cep },
        services: "1,2,17",
        options: {
          own_hand: false,
          receipt: false,
          insurance_value: seguro,
          use_insurance_value: seguro > 0,
        },
        package: {
          height: alturaCm,
          width: larguraCm,
          length: comprimentoCm,
          weight: pesoKg,
        },
      },
      {
        headers: {
          Authorization: "Bearer " + token,
          "User-Agent": "Estalise (contato@estalise.com)",
          "Content-Type": "application/json",
        },
      }
    );

    if (!Array.isArray(response.data)) {
      console.error("Formato inesperado do SuperFrete:", response.data);
      return res.status(500).json({ error: "Resposta inesperada do servico de frete." });
    }

    const opcoes = response.data
      .filter((o) => !o.has_error)
      .map((o) => ({
        id: o.id,
        nome: o.name,
        preco: o.price,
        prazo_dias: o.delivery_time,
      }));

    return res.status(200).json({ opcoes });
  } catch (error) {
    console.error("Erro ao calcular frete:", error.response ? error.response.data : error.message);
    return res.status(500).json({ error: "Falha ao calcular frete." });
  }
};
