const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const axios = require("axios");

if (!getApps().length) {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    initializeApp({
      credential: cert(serviceAccount)
    });
  } catch (err) {
    console.error(
      "Erro ao inicializar Firebase Admin:",
      err
    );
    throw err;
  }
}

const db = getFirestore();

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
    if (["pago", "pago_cartao", "em_producao", "enviado", "entregue"].includes(pedidoAtual.status)) {
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
          atualizado_em: FieldValue.serverTimestamp()
        },
        updated_at: FieldValue.serverTimestamp(),
        arquivado: false
      });

      return res.status(200).json({ success: true, divergente: true });
    }

    const metodo = String(
      capture_method || confirmacao.capture_method || ""
    ).toLowerCase();

    const dadosPagamento = {
      metodo,
      transaction_nsu: transaction_nsu || "",
      receipt_url: receipt_url || "",
      invoice_slug: invoice_slug || "",
      installments: Number(installments || confirmacao.installments || 1),
      valor_original: valorEsperado || Number(amount || 0) / 100,
      valor_pago: valorPagoConfirmado,
      atualizado_em: FieldValue.serverTimestamp()
    };

    // Pagamento validado (Pix ou cartão): confirma o pedido automaticamente
    await pedidoRef.update({
      status: "pago",
      pagamento: { status: "aprovado", ...dadosPagamento },
      pago_em: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      // Se o pedido tinha sido "zerado" no painel, volta a aparecer
      arquivado: false
    });

    console.log(
      `Pedido ${order_nsu} confirmado (${metodo || "pagamento"} validado via payment_check)`
    );

    // Contabiliza o uso do cupom (só em pedido efetivamente pago)
    if (pedidoAtual.cupom?.codigo) {
      await db.collection("cupons").doc(pedidoAtual.cupom.codigo)
        .update({ usos: FieldValue.increment(1) })
        .catch(err => console.warn("Falha ao contabilizar cupom:", err.message));
    }

    // Mensagem pro cliente (falha no envio não desfaz a confirmação)
    await enviarEmailConfirmacao(order_nsu, pedidoAtual, valorPagoConfirmado)
      .catch(err => console.error(
        "Falha ao enviar e-mail de confirmação:",
        err.response?.data || err.message
      ));

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

// =============================================================
// E-MAIL DE CONFIRMAÇÃO (via Resend — https://resend.com)
// Variáveis na Vercel: RESEND_API_KEY e EMAIL_FROM
// (ex.: "Estalise <pedidos@seudominio.com.br>")
// Sem RESEND_API_KEY o envio é apenas ignorado.
// =============================================================
async function enviarEmailConfirmacao(pedidoId, pedido, valorPago) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("RESEND_API_KEY não configurada: e-mail de confirmação não enviado.");
    return;
  }
  if (!pedido.user_id) return;

  const usuario = await getAuth().getUser(pedido.user_id);
  if (!usuario.email) return;

  const perfilDoc = await db.collection("usuarios").doc(pedido.user_id).get();
  const nome = (perfilDoc.exists && perfilDoc.data().nome_completo) || "";
  const primeiroNome = escapeHtml(nome.split(" ")[0] || "");
  const numero = escapeHtml(String(pedidoId).slice(0, 8));
  const valor = Number(valorPago || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const itens = (pedido.itens || []).map(i =>
    `<li>${escapeHtml(i.quantidade || 1)}x ${escapeHtml(i.nome || "Produto")}</li>`
  ).join("");

  await axios.post(
    "https://api.resend.com/emails",
    {
      from: process.env.EMAIL_FROM || "Estalise <onboarding@resend.dev>",
      to: [usuario.email],
      subject: `Pagamento confirmado — pedido #${numero}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#222">
          <h2>Pagamento confirmado! 🎉</h2>
          <p>Olá${primeiroNome ? `, ${primeiroNome}` : ""}! Recebemos o seu pagamento de <strong>${valor}</strong>
          referente ao pedido <strong>#${numero}</strong>.</p>
          ${itens ? `<ul>${itens}</ul>` : ""}
          <p>Sua peça já entrou na fila de produção. O prazo de produção é de até
          <strong>15 dias</strong> antes do envio, e você receberá o código de rastreio assim que for postada.</p>
          <p><a href="https://cases-estalise.vercel.app/conta.html">Acompanhar meu pedido</a></p>
          <p style="color:#888;font-size:12px">Estalise</p>
        </div>`
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  console.log(`E-mail de confirmação enviado para o pedido ${pedidoId}`);
}

function escapeHtml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
