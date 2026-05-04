import { createHmac } from 'crypto';
import { Router } from 'express';
import db from '../db/schema.js';
import { buscarPagamento } from '../lib/mp.js';

if (!process.env.MP_WEBHOOK_SECRET) {
  console.warn('[webhook] MP_WEBHOOK_SECRET não configurado — verificação de assinatura desativada');
}

// Verifica se a notificação veio realmente do Mercado Pago.
// Usa HMAC-SHA256 com o segredo configurado no painel MP → Webhooks.
function assinaturaValida(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sem segredo configurado, aceita (MP_API verifica no double-check)

  const xSig = req.headers['x-signature'] ?? '';
  const xReqId = req.headers['x-request-id'] ?? '';
  const parts = Object.fromEntries(xSig.split(',').map(p => p.split('=')));
  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) {
    console.warn('[webhook] assinatura ausente — requisição rejeitada');
    return false;
  }

  const dataId = req.body?.data?.id ?? '';
  const manifest = `id:${dataId};request-id:${xReqId};ts:${ts}`;
  const hash = createHmac('sha256', secret).update(manifest).digest('hex');
  return hash === v1;
}

const router = Router();

function pedidoRow(numero) {
  return db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
}

function mapBasico(r) {
  return {
    numero:         r.numero,
    cliente:        r.cliente,
    telefone:       r.telefone,
    status:         r.status,
    paymentStatus:  r.payment_status,
    paymentMethod:  r.payment_method,
    mpPaymentId:    r.mp_payment_id ?? null,
    total:          r.total,
    tipoEntrega:    r.tipo_entrega,
    endereco:       r.endereco,
    pagamento:      r.pagamento,
    taxaEntrega:    r.taxa_entrega ?? 0,
    bairroId:       r.bairro_id ?? null,
    needsRefund:    r.needs_refund === 1,
    observacao:     r.observacao,
    itens:          JSON.parse(r.itens_json),
    marmitas:       r.marmitas_json    ? JSON.parse(r.marmitas_json)    : [],
    bebidas:        r.bebidas_json     ? JSON.parse(r.bebidas_json)     : [],
    adicionais:     r.adicionais_json  ? JSON.parse(r.adicionais_json)  : [],
    formaPagamento:   r.forma_pagamento,
    momentoPagamento: r.momento_pagamento,
    pixExpiraEm:      r.pix_expira_em,
    motivoCancelamento: r.motivo_cancelamento ?? null,
    criadoEm:       r.criado_em,
    atualizadoEm:   r.atualizado_em,
  };
}

// Mercado Pago envia POST neste endpoint ao detectar mudança de status no pagamento.
// Respondemos 200 imediatamente e processamos em background para evitar retries do MP.
router.post('/mercadopago', async (req, res) => {
  // Verifica assinatura ANTES de processar
  if (!assinaturaValida(req)) {
    console.warn('[webhook] assinatura inválida — notificação ignorada');
    return res.status(200).json({ ok: true }); // 200 para MP não retentar; mas não processamos
  }

  res.status(200).json({ ok: true });

  try {
    const mpPaymentId = String(req.body?.data?.id || req.query?.id || '');
    if (!mpPaymentId || mpPaymentId === 'undefined') return;

    const payment = await buscarPagamento(mpPaymentId);

    const row = db.prepare('SELECT * FROM pedidos WHERE mp_payment_id = ?').get(mpPaymentId);
    if (!row) {
      console.warn(`[webhook] mp_payment_id ${mpPaymentId} não encontrado no banco`);
      return;
    }

    if (payment.status === 'approved' && row.payment_status !== 'CONFIRMED') {
      db.prepare(`
        UPDATE pedidos
        SET payment_status = 'CONFIRMED', status = 'PENDING_ACCEPTANCE', atualizado_em = datetime('now')
        WHERE numero = ?
      `).run(row.numero);

      const atualizado = mapBasico(pedidoRow(row.numero));
      req.io?.to('admin').emit('novo_pedido', atualizado);
      console.log(`[webhook] #${row.numero} — PIX confirmado via Mercado Pago`);

    } else if (['cancelled', 'rejected', 'expired'].includes(payment.status) && row.status === 'PENDING_PAYMENT') {
      db.prepare(`
        UPDATE pedidos
        SET status = 'REJECTED', motivo_cancelamento = 'expirado_pix', atualizado_em = datetime('now')
        WHERE numero = ?
      `).run(row.numero);

      const atualizado = mapBasico(pedidoRow(row.numero));
      req.io?.to('admin').emit('status_atualizado', atualizado);
      console.log(`[webhook] #${row.numero} — PIX ${payment.status}, pedido cancelado`);
    }
  } catch (err) {
    console.error('[webhook] erro ao processar notificação MP:', err.message);
  }
});

export default router;
