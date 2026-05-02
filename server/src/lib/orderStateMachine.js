export const STATUS = {
  PENDING_PAYMENT:    'PENDING_PAYMENT',
  PENDING_ACCEPTANCE: 'PENDING_ACCEPTANCE',
  REJECTED:           'REJECTED',
  IN_PRODUCTION:      'IN_PRODUCTION',
  OUT_FOR_DELIVERY:   'OUT_FOR_DELIVERY',
  DONE:               'DONE',
};

const TRANSITIONS = {
  [STATUS.PENDING_PAYMENT]:    [STATUS.PENDING_ACCEPTANCE, STATUS.REJECTED],
  [STATUS.PENDING_ACCEPTANCE]: [STATUS.IN_PRODUCTION, STATUS.REJECTED],
  [STATUS.IN_PRODUCTION]:      [STATUS.OUT_FOR_DELIVERY, STATUS.DONE, STATUS.REJECTED],
  [STATUS.OUT_FOR_DELIVERY]:   [STATUS.DONE],
  [STATUS.REJECTED]:           [STATUS.IN_PRODUCTION],
  [STATUS.DONE]:               [STATUS.IN_PRODUCTION],
};

export const PAYMENT_METHOD = {
  PIX:  'PIX',
  CASH: 'CASH',
};

export const PAYMENT_STATUS = {
  PENDING:        'PENDING',
  CONFIRMED:      'CONFIRMED',
  FAILED:         'FAILED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

// Normaliza o valor literal enviado pelo frontend para o enum interno.
// Qualquer coisa que não seja 'pix' (case-insensitive) é tratada como CASH,
// pois o pagamento ocorre no ato da entrega/retirada.
export function toPaymentMethod(pagamento) {
  return pagamento?.toLowerCase() === 'pix' ? PAYMENT_METHOD.PIX : PAYMENT_METHOD.CASH;
}

// O status inicial do pagamento depende apenas do método:
// PIX exige confirmação externa (webhook); CASH não tem fluxo de pagamento online.
export function getInitialPaymentStatus(paymentMethod) {
  return paymentMethod === PAYMENT_METHOD.PIX
    ? PAYMENT_STATUS.PENDING
    : PAYMENT_STATUS.NOT_APPLICABLE;
}

// O status inicial do pedido depende do método de pagamento:
// PIX fica em PENDING_PAYMENT até o webhook confirmar.
// CASH vai direto para PENDING_ACCEPTANCE (dono já pode aceitar).
export function getInitialStatus(paymentMethod) {
  return paymentMethod === PAYMENT_METHOD.PIX
    ? STATUS.PENDING_PAYMENT
    : STATUS.PENDING_ACCEPTANCE;
}

export const FORMA_PAGAMENTO = {
  PIX:      'pix',
  DINHEIRO: 'dinheiro',
  CARTAO:   'cartao',
};

// pix | dinheiro | cartao  (granularidade maior que PAYMENT_METHOD)
export function toFormaPagamento(pagamento) {
  const p = pagamento?.toLowerCase() ?? '';
  if (p === 'pix')      return FORMA_PAGAMENTO.PIX;
  if (p === 'dinheiro') return FORMA_PAGAMENTO.DINHEIRO;
  return FORMA_PAGAMENTO.CARTAO; // cartão débito / crédito
}

// online | entrega | retirada
// PIX é sempre pago online; cartão e dinheiro são presenciais.
export function toMomentoPagamento(forma, tipoEntrega) {
  if (forma === FORMA_PAGAMENTO.PIX) return 'online';
  return tipoEntrega === 'entrega' ? 'entrega' : 'retirada';
}

export function canTransition(statusAtual, novoStatus) {
  const permitidos = TRANSITIONS[statusAtual];

  if (!permitidos) {
    return { ok: false, motivo: `Status atual desconhecido: "${statusAtual}"` };
  }

  if (!permitidos.includes(novoStatus)) {
    return {
      ok: false,
      motivo: permitidos.length === 0
        ? `Pedido já está em status terminal: "${statusAtual}"`
        : `Transição inválida: "${statusAtual}" → "${novoStatus}". Permitido: ${permitidos.join(', ')}`,
    };
  }

  return { ok: true };
}
