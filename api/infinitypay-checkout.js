const axios =
  require("axios");

module.exports =
async (req, res) => {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(200)
      .end();
  }

  if (
    req.method !==
    "POST"
  ) {
    return res
      .status(405)
      .json({
        error:
          "Método não permitido"
      });
  }

  try {

    const {
      id,
      itens
    } = req.body;

    const response =
      await axios.post(
        "https://api.checkout.infinitepay.io/links",
        {
          handle:
            "paulo-estalise",

          items:
            itens.map(
              (
                item
              ) => ({
                quantity:
                  item.quantidade,

                price:
                  Math.round(
                    item.preco_unitario *
                    100
                  ),

                description:
                  item.nome
              })
            ),

          order_nsu:
            id,

          redirect_url:
            "https://cases-estalise.vercel.app/pedido-confirmado.html",

          webhook_url:
            "https://api-case.vercel.app/api/infinitypay-webhook"
        }
      );

    console.log(
      response.data
    );

    return res.json({
      checkout_url:
        response.data
          .url ||

        response.data
          .link ||

        response.data
          .checkout_url
    });

  }
  catch (err) {

    console.error(
      err.response
        ?.data ||
      err
    );

    return res
      .status(500)
      .json({
        error:
          "Erro ao criar checkout."
      });
  }
};