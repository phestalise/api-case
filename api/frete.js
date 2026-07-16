// api/frete.js
const axios = require("axios");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  try {
    const token = process.env.SUPERFRETE_TOKEN;
    const baseUrl = process.env.SUPERFRETE_BASE_URL;
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

    if (!cepDestino || !peso) {
      return res.status(400).json({ error: "Dados incompletos." });
    }

    const response = await axios.post(
      baseUrl + "/calculator",
      {
        from: { postal_code: cepOrigem },
        to: { postal_code: String(cepDestino).replace(/\D/g, "") },
        products: [{
          weight: peso,
          height: altura,
          width: largura,
          length: comprimento,
          insurance_value: valorDeclarado,
          quantity: 1,
        }],
      },
      { headers: { Authorization: "Bearer " + token } }
    );

    const opcoes = response.data.map((o) => ({
      id: o.id,
      nome: o.name,
      preco: o.price,
      prazo_dias: o.delivery_time,
    }));

    res.status(200).json({ opcoes });
  } catch (error) {
    const detalhe = error.response ? error.response.data : error.message;
    console.error("Erro ao calcular frete:", detalhe);
    res.status(500).json({ error: "Falha ao calcular frete.", detalhe: detalhe });
  }
};