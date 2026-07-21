const admin = require("firebase-admin");
const axios = require("axios");

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (err) {
    console.error(
      "Erro ao inicializar Firebase Admin:",
      err
    );
    throw err;
  }
}

const db = admin.firestore();

// Handle da sua conta InfinitePay (mesmo usado no link de pagamento)
const INFINITEPAY_HANDLE = "paulo-estalise";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    console.log(
      "Webhook recebido:",
      JSON.stringify(req.body, null, 2)
    );

    const {
      order_nsu,
      transaction_nsu,
      receipt_url,
      capture_method,
      amount,
      paid_amount,
      installments,
      invoice_slug
    } = req.body;

    if (!order_nsu) {
      return res.status(400).json({
        error: "order_nsu não informado."
      });
    }

    const pedidoRef = db
      .collection("pedidos")
      .doc(order_nsu);

    const pedidoDoc = await pedidoRef.get();

    if (!pedidoDoc.exists) {
      // Não existe pedido correspondente: não é um erro seu,
      // mas responde 400 pra InfinitePay não ficar retentando à toa.
      console.warn(
        `Webhook recebido para pedido inexistente: ${order_nsu}`
      );
      return res.status(400).json({
        error: "Pedido não encontrado."
      });
    }

    // Idempotência: se já está pago, não faz nada de novo
    // (evita reprocessar caso a InfinitePay reenvie o mesmo webhook)
    const pedidoAtual = pedidoDoc.data();
    if (pedidoAtual.status === "pago") {
      console.log(
        `Pedido ${order_nsu} já estava marcado como pago. Ignorando reenvio.`
      );
      return res.status(200).json({ success: true, ja_processado: true });
    }

    // ---------------------------------------------------------------
    // VALIDAÇÃO SERVER-TO-SERVER
    // Em vez de confiar direto no corpo do webhook (que não tem
    // assinatura/token de segurança), confirmamos com a própria
    // InfinitePay se esse pagamento realmente existe e foi aprovado.
    // ---------------------------------------------------------------
    let confirmacao;
    try {
      const checkResponse = await axios.post(
        "https://api.checkout.infinitepay.io/payment_check",
        {
          handle: INFINITEPAY_HANDLE,
          order_nsu: String(order_nsu),
          transaction_nsu: transaction_nsu || "",
          slug: invoice_slug || ""
        },
        { headers: { "Content-Type": "application/json" } }
      );
      confirmacao = checkResponse.data;
    } catch (checkError) {
      console.error(
        "Erro ao validar pagamento com payment_check:",
        checkError.response?.data || checkError.message
      );
      return res.status(400).json({
        error: "Não foi possível validar o pagamento junto à InfinitePay."
      });
    }

    if (!confirmacao?.success || !confirmacao?.paid) {
      console.warn(
        `payment_check não confirmou pagamento para pedido ${order_nsu}:`,
        confirmacao
      );
      return res.status(400).json({
        error: "Pagamento não confirmado pela InfinitePay."
      });
    }

    // Confere se o valor pago bate com o valor esperado do pedido
    // (proteção extra contra pedido certo mas valor divergente)
    const valorEsperado = Number(pedidoAtual.total || 0);
    const valorPagoConfirmado = Number(confirmacao.paid_amount || 0) / 100;

    if (valorEsperado > 0 && Math.abs(valorEsperado - valorPagoConfirmado) > 0.01) {
      console.warn(
        `Divergência de valor no pedido ${order_nsu}: esperado ${valorEsperado}, pago ${valorPagoConfirmado}`
      );
      // Marca como "pago_divergente" para revisão manual, em vez de "pago" direto
      await pedidoRef.update({
        status: "pago_divergente",
        pagamento: {
          status: "divergente",
          metodo: capture_method || confirmacao.capture_method || "",
          transaction_nsu: transaction_nsu || "",
          receipt_url: receipt_url || "",
          invoice_slug: invoice_slug || "",
          installments: Number(installments || confirmacao.installments || 1),
          valor_original: valorEsperado,
          valor_pago: valorPagoConfirmado,
          atualizado_em: admin.firestore.FieldValue.serverTimestamp()
        },
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({ success: true, divergente: true });
    }

    // Tudo validado: marca como pago de fato
    await pedidoRef.update({
      status: "pago",

      pagamento: {
        status: "aprovado",
        metodo: capture_method || confirmacao.capture_method || "",
        transaction_nsu: transaction_nsu || "",
        receipt_url: receipt_url || "",
        invoice_slug: invoice_slug || "",
        installments: Number(installments || confirmacao.installments || 1),
        valor_original: valorEsperado || Number(amount || 0) / 100,
        valor_pago: valorPagoConfirmado,
        atualizado_em: admin.firestore.FieldValue.serverTimestamp()
      },

      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(
      `Pedido ${order_nsu} atualizado para pago (validado via payment_check)`
    );

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error(
      "Erro no webhook:",
      error
    );

    return res.status(500).json({
      error: "Erro interno.",
      detalhe: error.message
    });
  }
};