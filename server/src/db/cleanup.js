// src/db/cleanup.js
// Tarefas agendadas de manutenção do banco.

import db from './schema.js';

export function limparPedidosAntigos() {
  // Aviso preventivo: informa quantos pedidos serão deletados antes de agir
  const { total } = db.prepare(
    `SELECT COUNT(*) as total FROM pedidos WHERE criado_em < datetime('now', '-1 year')`
  ).get();

  if (total > 0) {
    console.warn(`[cleanup] ⚠  ${total} pedido(s) com mais de 1 ano serão removidos.`);
  }

  const info = db.prepare(
    `DELETE FROM pedidos WHERE criado_em < datetime('now', '-1 year')`
  ).run();

  if (info.changes > 0) console.log(`[cleanup] ${info.changes} pedido(s) antigo(s) removido(s).`);
  return info.changes;
}

// Cancela automaticamente pedidos PIX que não foram pagos dentro do prazo.
export function cancelarPixExpirados() {
  const info = db.prepare(`
    UPDATE pedidos
    SET    status = 'REJECTED',
           motivo_cancelamento = 'expirado_pix',
           atualizado_em = datetime('now')
    WHERE  payment_method = 'PIX'
      AND  status         = 'PENDING_PAYMENT'
      AND  pix_expira_em  IS NOT NULL
      AND  pix_expira_em  < datetime('now')
  `).run();
  if (info.changes > 0) {
    console.log(`[pix] ${info.changes} pedido(s) expirado(s) — cancelados automaticamente`);
  }
  return info.changes;
}

export function iniciarAgendamentoLimpeza() {
  limparPedidosAntigos();
  cancelarPixExpirados();
  setInterval(limparPedidosAntigos,  24 * 60 * 60 * 1000); // diário
  setInterval(cancelarPixExpirados,       2 * 60 * 1000);  // a cada 2 min
}
