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
    console.error(
      "Erro ao inicializar Firebase Admin:",
      err
    );
    throw err;
  }
}

const db = admin.firestore();

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
      return res.status(404).json({
        error: "Pedido não encontrado."
      });
    }

    await pedidoRef.update({
      status: "pago",

      pagamento: {
        status: "aprovado",
        metodo: capture_method || "",
        transaction_nsu:
          transaction_nsu || "",
        receipt_url:
          receipt_url || "",
        invoice_slug:
          invoice_slug || "",
        installments:
          Number(installments || 1),
        valor_original:
          Number(amount || 0) / 100,
        valor_pago:
          Number(paid_amount || 0) / 100,
        atualizado_em:
          admin.firestore.FieldValue.serverTimestamp()
      },

      updated_at:
        admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(
      `Pedido ${order_nsu} atualizado para pago`
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