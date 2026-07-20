const axios = require("axios");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const {
      id,
      itens
    } = req.body;

    if (!id) {
      return res.status(400).json({
        error: "ID do pedido não informado."
      });
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({
        error: "Itens do pedido não informados."
      });
    }

    const payload = {
      handle: "paulo-estalise",

      items: itens.map((item) => ({
        quantity: Number(item.quantidade || 1),

        // InfinitePay recebe em centavos
        price: Math.round(
          Number(item.preco_unitario || 0) * 100
        ),

        description:
          item.nome || "Produto"
      })),

      order_nsu: id,

      redirect_url:
        "https://cases-estalise.vercel.app/pedido-confirmado.html",

      webhook_url:
        "https://api-case.vercel.app/api/infinitypay-webhook"
    };

    console.log(
      "Payload enviado:",
      JSON.stringify(payload, null, 2)
    );

    const response = await axios.post(
      "https://api.checkout.infinitepay.io/links",
      payload,
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log(
      "Resposta InfinitePay:",
      response.data
    );

    const checkoutUrl =
      response.data?.checkout_url ||
      response.data?.url ||
      response.data?.link ||
      response.data?.payment_url;

    if (!checkoutUrl) {
      return res.status(500).json({
        error: "InfinitePay não retornou URL.",
        detalhe: response.data
      });
    }

    return res.status(200).json({
      success: true,
      checkout_url: checkoutUrl
    });

  } catch (error) {

    console.error(
      "Erro InfinitePay:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Erro ao criar checkout.",
      detalhe:
        error.response?.data ||
        error.message
    });
  }
};