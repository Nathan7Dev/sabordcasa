// src/routes/clientes.js
import { Router } from 'express';
import db from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

// Público: registrar ou atualizar cliente (chamado pelo site)
router.post('/registrar', (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome?.trim())      return res.status(400).json({ erro: 'Nome obrigatório' });
  if (!telefone?.trim())  return res.status(400).json({ erro: 'Telefone obrigatório' });

  const tel = String(telefone).replace(/\D/g, '');
  if (tel.length < 10) return res.status(400).json({ erro: 'Telefone inválido' });

  const existing = db.prepare('SELECT id FROM clientes WHERE telefone = ?').get(tel);
  if (existing) {
    db.prepare(`UPDATE clientes SET nome = ?, ultimo_em = datetime('now') WHERE telefone = ?`)
      .run(nome.trim(), tel);
    return res.json({ ok: true, novo: false });
  }

  db.prepare(`INSERT INTO clientes (nome, telefone) VALUES (?, ?)`).run(nome.trim(), tel);
  res.status(201).json({ ok: true, novo: true });
});

// Protegido: listar clientes com métricas de pedidos
router.get('/', requireApiKey, (req, res) => {
  const busca  = req.query.busca?.trim() || '';
  const limite = Math.min(parseInt(req.query.limite) || 500, 2000);

  const sql = `
    SELECT
      c.id, c.nome, c.telefone, c.criado_em, c.ultimo_em,
      COUNT(p.numero)                                                              AS total_pedidos,
      COALESCE(SUM(CASE WHEN p.status != 'REJECTED' THEN p.total ELSE 0 END), 0) AS total_gasto,
      MAX(p.criado_em)                                                             AS ultimo_pedido
    FROM clientes c
    LEFT JOIN pedidos p ON p.telefone = c.telefone
    ${busca ? 'WHERE c.nome LIKE ? OR c.telefone LIKE ?' : ''}
    GROUP BY c.id
    ORDER BY total_pedidos DESC, c.ultimo_em DESC
    LIMIT ?
  `;

  const params = busca ? [`%${busca}%`, `%${busca}%`, limite] : [limite];
  res.json(db.prepare(sql).all(...params));
});

// Protegido: pedidos de um cliente específico
router.get('/:telefone/pedidos', requireApiKey, (req, res) => {
  const tel = String(req.params.telefone).replace(/\D/g, '');
  const rows = db.prepare(
    `SELECT numero, status, total, tipo_entrega, pagamento, forma_pagamento, criado_em
     FROM pedidos WHERE telefone = ? ORDER BY criado_em DESC LIMIT 100`
  ).all(tel);
  res.json(rows.map(r => ({
    numero:        r.numero,
    status:        r.status,
    total:         r.total,
    tipoEntrega:   r.tipo_entrega,
    pagamento:     r.pagamento,
    formaPagamento: r.forma_pagamento,
    criadoEm:      r.criado_em,
  })));
});

export default router;
