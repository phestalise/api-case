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
      itens,
      frete
    } = req.body;


    if (!id) {
      return res.status(400).json({
        error:"ID do pedido não informado."
      });
    }


    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({
        error:"Carrinho vazio."
      });
    }



    const items = itens.map(item => {

      const preco =
        Number(
          item.preco_unitario ||
          item.preco ||
          item.preco_padrao ||
          0
        );


      return {

        quantity:
          Number(item.quantidade || 1),


        price:
          Math.round(preco * 100),


        description:
          item.nome || "Produto"

      };

    });



    // adiciona frete como item
    if (frete && Number(frete.valor) > 0) {

      items.push({

        quantity:1,

        price:
          Math.round(
            Number(frete.valor) * 100
          ),

        description:
          `Frete - ${frete.servico || "Entrega"}`

      });

    }



    const payload = {

      handle:
        "paulo-estalise",


      items,


      order_nsu:
        String(id),


      redirect_url:
        "https://cases-estalise.vercel.app/pedido-confirmado.html",


      webhook_url:
        "https://api-case.vercel.app/api/infinitypay-webhook"

    };



    console.log(
      "PAYLOAD INFINITEPAY"
    );

    console.log(
      JSON.stringify(
        payload,
        null,
        2
      )
    );



    const response =
      await axios.post(
        "https://api.checkout.infinitepay.io/links",
        payload,
        {
          headers:{
            "Content-Type":
              "application/json"
          }
        }
      );



    const checkoutUrl =
      response.data?.url ||
      response.data?.link ||
      response.data?.checkout_url;



    if(!checkoutUrl){

      return res.status(500).json({

        error:
        "InfinitePay não retornou link",

        retorno:
        response.data

      });

    }



    return res.status(200).json({

      success:true,

      checkout_url:
        checkoutUrl

    });



  } catch(error){


    console.error(
      "ERRO INFINITEPAY",
      error.response?.data ||
      error.message
    );


    return res.status(500).json({

      error:
      "Erro ao gerar pagamento",

      detalhe:
      error.response?.data ||
      error.message

    });

  }

};