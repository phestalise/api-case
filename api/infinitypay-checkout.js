const axios = require("axios");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (err) {
    console.error("Erro ao inicializar Firebase Admin:", err);
    throw err;
  }
}

const db = admin.firestore();

module.exports = async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "https://cases-estalise.vercel.app");
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
    const { id, itens, frete } = req.body;

    if (!id) {
      return res.status(400).json({ error: "ID do pedido não informado." });
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: "Carrinho vazio." });
    }

    // -----------------------------------------------------------
    // VALIDAÇÃO SERVER-SIDE DE PREÇO
    // Nunca confiamos no preco_unitario que vem do cliente.
    // Buscamos o preço real de cada produto direto no Firestore.
    // -----------------------------------------------------------
    const itemsValidados = [];
    let totalValidado = 0;

    for (const item of itens) {
      if (!item.produto_id) {
        return res.status(400).json({
          error: "Item do carrinho sem produto_id."
        });
      }

      const produtoDoc = await db.collection("produtos").doc(item.produto_id).get();

      if (!produtoDoc.exists) {
        return res.status(400).json({
          error: `Produto ${item.produto_id} não encontrado.`
        });
      }

      const produto = produtoDoc.data();

      if (produto.ativo === false) {
        return res.status(400).json({
          error: `Produto "${produto.nome || item.produto_id}" não está mais disponível.`
        });
      }

      // Preço vem do Firestore, nunca do body da requisição.
      const precoReal = item.is_personalizado
        ? Number(produto.preco_personalizado || 0)
        : Number(produto.preco_padrao || 0);

      const quantidade = Math.max(1, Number(item.quantidade || 1));

      itemsValidados.push({
        quantity: quantidade,
        price: Math.round(precoReal * 100),
        description: produto.nome || "Produto"
      });

      totalValidado += precoReal * quantidade;
    }

    const valorFrete = frete && Number(frete.valor) > 0 ? Number(frete.valor) : 0;

    if (valorFrete > 0) {
      itemsValidados.push({
        quantity: 1,
        price: Math.round(valorFrete * 100),
        description: `Frete - ${frete.servico || "Entrega"}`
      });
    }

    totalValidado += valorFrete;

    // Atualiza o pedido no Firestore com os valores reais e confiáveis,
    // para que o webhook compare o pagamento contra o total correto.
    const pedidoRef = db.collection("pedidos").doc(String(id));
    const pedidoDoc = await pedidoRef.get();

    if (!pedidoDoc.exists) {
      return res.status(400).json({ error: "Pedido não encontrado." });
    }

    await pedidoRef.update({
      total: totalValidado,
      valor_frete: valorFrete,
      total_validado_em: admin.firestore.FieldValue.serverTimestamp()
    });

    const payload = {
      handle: "paulo-estalise",
      items: itemsValidados,
      order_nsu: String(id),
      redirect_url: "https://cases-estalise.vercel.app/pedido-confirmado.html",
      webhook_url: "https://api-case.vercel.app/api/infinitypay-webhook"
    };

    const response = await axios.post(
      "https://api.checkout.infinitepay.io/links",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const checkoutUrl =
      response.data?.url ||
      response.data?.link ||
      response.data?.checkout_url;

    if (!checkoutUrl) {
      return res.status(500).json({
        error: "InfinitePay não retornou link",
        retorno: response.data
      });
    }

    return res.status(200).json({
      success: true,
      checkout_url: checkoutUrl
    });

  } catch (error) {
    console.error(
      "ERRO INFINITEPAY",
      error.response?.data || error.message
    );

    return res.status(500).json({
      error: "Erro ao gerar pagamento",
      detalhe: error.response?.data || error.message
    });
  }
};