const admin =
  require(
    "firebase-admin"
  );

if (
  !admin.apps.length
) {
  admin.initializeApp({
    credential:
      admin.credential.cert(
        JSON.parse(
          process.env
            .FIREBASE_SERVICE_ACCOUNT
        )
      )
  });
}

const db =
  admin.firestore();

module.exports =
async (
  req,
  res
) => {

  if (
    req.method !==
    "POST"
  ) {
    return res
      .status(405)
      .end();
  }

  try {

    const {
      order_nsu,
      transaction_nsu,
      receipt_url,
      capture_method,
      amount,
      paid_amount,
      installments,
      invoice_slug
    } =
      req.body;

    const pedidoRef =
      db.collection(
        "pedidos"
      )
      .doc(
        order_nsu
      );

    await pedidoRef.update(
      {
        status:
          "pago",

        pagamento:
        {
          status:
            "aprovado",

          metodo:
            capture_method ||
            "",

          transaction_nsu:
            transaction_nsu ||
            "",

          receipt_url:
            receipt_url ||
            "",

          invoice_slug:
            invoice_slug ||
            "",

          installments:
            installments ||
            1,

          valor_original:
            (
              amount ||
              0
            ) /
            100,

          valor_pago:
            (
              paid_amount ||
              0
            ) /
            100
        },

        updated_at:
          admin
            .firestore
            .FieldValue
            .serverTimestamp()
      }
    );

    return res
      .status(200)
      .json({
        success:
          true
      });

  }
  catch (
    error
  ) {

    console.error(
      error
    );

    return res
      .status(500)
      .json({
        error:
          "Erro interno"
      });
  }
};