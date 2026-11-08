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
    const { id, itens, frete, cupom } = req.body;

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

    const subtotalValidado = totalValidado;

    // -----------------------------------------------------------
    // CUPOM DE DESCONTO (validado no servidor)
    // O desconto incide só sobre os produtos, nunca sobre o frete.
    // -----------------------------------------------------------
    let desconto = 0;
    let cupomAplicado = null;

    if (cupom) {
      const resultadoCupom = await validarCupom(cupom, subtotalValidado);
      if (resultadoCupom.erro) {
        return res.status(400).json({ error: resultadoCupom.erro });
      }
      desconto = resultadoCupom.desconto;
      cupomAplicado = resultadoCupom.cupom;
    }

    totalValidado = arredondar(subtotalValidado - desconto + valorFrete);

    if (totalValidado < 1) {
      return res.status(400).json({ error: "O valor final do pedido deve ser de pelo menos R$ 1,00." });
    }

    // Atualiza o pedido no Firestore com os valores reais e confiáveis,
    // para que o webhook compare o pagamento contra o total correto.
    const pedidoRef = db.collection("pedidos").doc(String(id));
    const pedidoDoc = await pedidoRef.get();

    if (!pedidoDoc.exists) {
      return res.status(400).json({ error: "Pedido não encontrado." });
    }

    const pedidoData = pedidoDoc.data();

    await pedidoRef.update({
      subtotal: arredondar(subtotalValidado),
      desconto: arredondar(desconto),
      cupom: cupomAplicado,
      total: totalValidado,
      valor_frete: valorFrete,
      status: "aguardando_pagamento",
      "pagamento.valor": totalValidado,
      total_validado_em: admin.firestore.FieldValue.serverTimestamp()
    });

    // Com desconto, a InfinitePay não aceita item com valor negativo,
    // então enviamos um único item com o total já descontado.
    const itemsParaPagamento = desconto > 0
      ? [{
          quantity: 1,
          price: Math.round(totalValidado * 100),
          description: `Pedido Estalise #${String(id).slice(0, 8)} (cupom ${cupomAplicado.codigo})`
        }]
      : itemsValidados;

    const payload = {
      handle: "paulo-estalise",
      items: itemsParaPagamento,
      order_nsu: String(id),
      redirect_url: `https://cases-estalise.vercel.app/pedido-confirmado.html?pedido=${encodeURIComponent(String(id))}`,
      webhook_url: "https://api-case.vercel.app/api/infinitypay-webhook"
    };

    // Dados do cliente pré-preenchidos no checkout da InfinitePay
    const customer = await montarCliente(pedidoData.user_id);
    if (customer) payload.customer = customer;

    // Com API Key (opcional), dá pra configurar desconto automático no Pix.
    // O cartão NÃO pode ser desligado na InfinitePay ("O cartão fica sempre
    // ligado"), então o bloqueio de cartão é feito no webhook.
    const headers = { "Content-Type": "application/json" };
    if (process.env.INFINITEPAY_API_KEY) {
      headers["X-Api-Key"] = process.env.INFINITEPAY_API_KEY;
    }

    const response = await axios.post(
      "https://api.checkout.infinitepay.io/links",
      payload,
      { headers }
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

// =============================================================
// HELPERS
// =============================================================

function arredondar(valor) {
  return Math.round(Number(valor || 0) * 100) / 100;
}

// Cupons ficam em cupons/{CODIGO} (código em maiúsculas).
async function validarCupom(codigoBruto, subtotal) {
  const codigo = String(codigoBruto).trim().toUpperCase();
  if (!codigo) return { desconto: 0, cupom: null };

  const cupomDoc = await db.collection("cupons").doc(codigo).get();
  if (!cupomDoc.exists) return { erro: "Cupom inválido." };

  const c = cupomDoc.data();

  if (c.ativo === false) return { erro: "Este cupom não está mais ativo." };

  if (c.validade && c.validade.toDate && c.validade.toDate() < new Date()) {
    return { erro: "Este cupom expirou." };
  }

  if (Number(c.usos_max) > 0 && Number(c.usos || 0) >= Number(c.usos_max)) {
    return { erro: "Este cupom atingiu o limite de usos." };
  }

  if (Number(c.valor_minimo) > 0 && subtotal < Number(c.valor_minimo)) {
    return { erro: `Este cupom exige compra mínima de R$ ${Number(c.valor_minimo).toFixed(2)}.` };
  }

  const valor = Number(c.valor || 0);
  let desconto = c.tipo === "fixo" ? valor : subtotal * (valor / 100);
  desconto = Math.min(Math.max(0, desconto), subtotal);

  return {
    desconto: arredondar(desconto),
    cupom: { codigo, tipo: c.tipo === "fixo" ? "fixo" : "percentual", valor }
  };
}

async function montarCliente(userId) {
  if (!userId) return null;
  try {
    const [authUser, perfilDoc] = await Promise.all([
      admin.auth().getUser(userId).catch(() => null),
      db.collection("usuarios").doc(userId).get()
    ]);
    const perfil = perfilDoc.exists ? perfilDoc.data() : {};
    const customer = {};
    if (perfil.nome_completo) customer.name = perfil.nome_completo;
    if (authUser?.email) customer.email = authUser.email;
    const telefone = String(perfil.telefone || "").replace(/\D/g, "");
    if (telefone.length >= 10) customer.phone_number = `+55${telefone.replace(/^55(?=\d{10,11}$)/, "")}`;
    return Object.keys(customer).length ? customer : null;
  } catch (err) {
    console.warn("Não foi possível montar dados do cliente:", err.message);
    return null;
  }
}
