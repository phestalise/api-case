const axios = require("axios");

module.exports = async (req, res) => {

    try {

        const pedido = req.body;

        const response = await axios.post(
            "https://api.checkout.infinitepay.io/links",
            {
                handle: "paulo-estalise",

                items: pedido.itens.map(item => ({
                    quantity: item.quantidade,
                    price: Math.round(item.preco_unitario * 100),
                    description: item.nome
                })),

                order_nsu: pedido.id,

                redirect_url:
                "https://www.estalise.com/pedido-confirmado.html",

                webhook_url:
                "https://www.estalise.com/api/infinitypay-webhook"

            }
        );

        res.json(response.data);

    } catch (err) {

        console.error(err.response?.data || err);

        res.status(500).json({
            error:"Erro ao criar checkout."
        });

    }

}