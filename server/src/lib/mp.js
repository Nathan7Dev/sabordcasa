import MercadoPagoConfig, { Payment, PaymentRefund } from 'mercadopago';

if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('[mp] MP_ACCESS_TOKEN não configurado — pagamentos PIX online desativados');
}

const client    = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN ?? '' });
const paymentApi = new Payment(client);
const refundApi  = new PaymentRefund(client);

export const mpAtivo = () => Boolean(process.env.MP_ACCESS_TOKEN);

export async function criarPix({ valor, descricao, nomeCliente, telefone, idempotencyKey }) {
  const digits = String(telefone).replace(/\D/g, '');
  const result = await paymentApi.create({
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
  return paymentApi.get({ id: String(mpPaymentId) });
}

export async function estornar(mpPaymentId) {
  return refundApi.create({ payment_id: String(mpPaymentId), body: {} });
}
