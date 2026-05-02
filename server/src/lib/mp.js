import MercadoPagoConfig, { Payment, PaymentRefund } from 'mercadopago';

export const mpAtivo = () => Boolean(process.env.MP_ACCESS_TOKEN);

// Inicialização lazy — o cliente só é criado na primeira chamada real,
// evitando crash de startup quando MP_ACCESS_TOKEN ainda não está configurado.
let _payment = null;
let _refund  = null;

function getPayment() {
  if (!_payment) {
    const c = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    _payment = new Payment(c);
  }
  return _payment;
}

function getRefund() {
  if (!_refund) {
    const c = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    _refund = new PaymentRefund(c);
  }
  return _refund;
}

export async function criarPix({ valor, descricao, nomeCliente, telefone, idempotencyKey }) {
  const digits = String(telefone).replace(/\D/g, '');
  const result = await getPayment().create({
    body: {
      transaction_amount:  parseFloat(valor.toFixed(2)),
      description:         descricao.slice(0, 255),
      payment_method_id:   'pix',
      date_of_expiration:  new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      payer: {
        email:      `${digits}@clientes.sabordc.com.br`,
        first_name: nomeCliente.split(' ')[0].slice(0, 60),
      },
    },
    requestOptions: { idempotencyKey },
  });

  return {
    mpPaymentId:  String(result.id),
    qrCode:       result.point_of_interaction?.transaction_data?.qr_code        ?? null,
    qrCodeBase64: result.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
  };
}

export async function buscarPagamento(mpPaymentId) {
  return getPayment().get({ id: String(mpPaymentId) });
}

export async function estornar(mpPaymentId) {
  return getRefund().create({ payment_id: String(mpPaymentId), body: {} });
}
