// src/routes/pedidos.js
import { Router } from 'express';
import db from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';
import {
  STATUS, PAYMENT_METHOD, PAYMENT_STATUS,
  toPaymentMethod, getInitialPaymentStatus, getInitialStatus,
  canTransition, toFormaPagamento, toMomentoPagamento,
} from '../lib/orderStateMachine.js';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  PÚBLICO — criação de pedido pelo site
// ═══════════════════════════════════════════════════════════
router.post('/', (req, res) => {
  const {
    cliente, telefone,
    tipoEntrega, endereco, pagamento, observacao,
    marmitas,
    bebidas    = [],   // [{id, quantidade}]
    adicionais = [],   // [{id, quantidade}]
    bairroId,
  } = req.body;

  if (!nomeClienteValido(cliente))
    return res.status(400).json({ erro: 'Nome do cliente inválido (mínimo 2 caracteres, deve conter letras)' });
  if (!telefone?.trim())
    return res.status(400).json({ erro: 'Telefone obrigatório' });
  if (!telefoneValido(telefone))
    return res.status(400).json({ erro: 'Telefone inválido (mínimo 10 dígitos)' });
  if (!['retirada', 'entrega'].includes(tipoEntrega))
    return res.status(400).json({ erro: 'Tipo de entrega inválido' });
  if (tipoEntrega === 'entrega' && !endereco?.trim())
    return res.status(400).json({ erro: 'Endereço obrigatório para entrega' });
  if (!pagamento)
    return res.status(400).json({ erro: 'Forma de pagamento obrigatória' });

  // Loja aberta?
  const cfg = db.prepare(`SELECT valor FROM configuracoes WHERE chave = 'loja_aberta'`).get();
  if (cfg?.valor === '0')
    return res.status(503).json({ erro: 'A loja está fechada no momento. Tente mais tarde.' });

  const marmitasNorm = Array.isArray(marmitas) && marmitas.length > 0 ? marmitas : [];

  // Pedido precisa ter ao menos 1 produto (marmita, bebida ou adicional)
  const temBebidas    = Array.isArray(bebidas)    && bebidas.length > 0;
  const temAdicionais = Array.isArray(adicionais) && adicionais.length > 0;
  if (!marmitasNorm.length && !temBebidas && !temAdicionais)
    return res.status(400).json({ erro: 'Pedido sem itens' });

  const validacao = marmitasNorm.length
    ? validarERecalcularMarmitas(marmitasNorm)
    : { erro: null, marmitas: [], total: 0 };
  if (validacao.erro) return res.status(400).json({ erro: validacao.erro });

  const validacaoBebidas = validarERecalcularItensLivres(bebidas, 'bebida');
  if (validacaoBebidas.erro) return res.status(400).json({ erro: validacaoBebidas.erro });

  const validacaoAdicionais = validarERecalcularItensLivres(adicionais, 'adicional');
  if (validacaoAdicionais.erro) return res.status(400).json({ erro: validacaoAdicionais.erro });

  const { marmitas: marmitasValidadas, total: totalMarmitas }  = validacao;
  const { itens: bebidasValidadas,    total: totalBebidas }    = validacaoBebidas;
  const { itens: adicionaisValidados, total: totalAdicionais } = validacaoAdicionais;
  const itensFlat = marmitasValidadas.flatMap(m =>
    Array.from({ length: m.quantidade || 1 }, () => m.itens).flat()
  );

  // Taxa de entrega por bairro
  let taxaEntrega = 0;
  let bairroIdFinal = null;
  if (tipoEntrega === 'entrega' && bairroId) {
    const bairro = db.prepare('SELECT id, taxa_entrega FROM bairros WHERE id = ? AND ativo = 1').get(Number(bairroId));
    if (!bairro) return res.status(400).json({ erro: 'Bairro não encontrado' });
    taxaEntrega   = bairro.taxa_entrega;
    bairroIdFinal = bairro.id;
  }
  const totalFinal = totalMarmitas + totalBebidas + totalAdicionais + taxaEntrega;

  const paymentMethod    = toPaymentMethod(pagamento);
  const paymentStatus    = getInitialPaymentStatus(paymentMethod);
  const statusInicial    = getInitialStatus(paymentMethod);
  const formaPagamento   = toFormaPagamento(pagamento);
  const momentoPagamento = toMomentoPagamento(formaPagamento, tipoEntrega);
  const pixExpiraEm = paymentMethod === PAYMENT_METHOD.PIX
    ? new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  const tx = db.transaction(() => {
    db.prepare('UPDATE contador SET valor = valor + 1 WHERE chave = ?').run('pedido');
    const { valor } = db.prepare('SELECT valor FROM contador WHERE chave = ?').get('pedido');
    const numero = String(valor).padStart(4, '0');

    db.prepare(`
      INSERT INTO pedidos
        (numero, cliente, telefone, itens_json, total, tipo_entrega, endereco,
         pagamento, payment_method, payment_status, observacao, status,
         marmitas_json, bebidas_json, adicionais_json, forma_pagamento, momento_pagamento, pix_expira_em,
         bairro_id, taxa_entrega)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      numero, cliente.trim(), telefone.trim(),
      JSON.stringify(itensFlat), totalFinal,
      tipoEntrega, endereco?.trim() || null,
      pagamento, paymentMethod, paymentStatus,
      observacao?.trim() || null, statusInicial,
      marmitasValidadas.length > 0 ? JSON.stringify(marmitasValidadas) : null,
      bebidasValidadas.length    > 0 ? JSON.stringify(bebidasValidadas)    : null,
      adicionaisValidados.length > 0 ? JSON.stringify(adicionaisValidados) : null,
      formaPagamento, momentoPagamento, pixExpiraEm,
      bairroIdFinal, taxaEntrega,
    );
    return numero;
  });

  const numero = tx();
  const pedido = buscarPedido(numero);

  console.log(`[pedido] #${numero} | total: R$${totalFinal.toFixed(2)} | ${tipoEntrega}`);

  if (pedido.status === STATUS.PENDING_ACCEPTANCE)
    req.io?.to('admin').emit('novo_pedido', pedido);

  res.status(201).json(pedido);
});

// ═══════════════════════════════════════════════════════════
//  LISTAR com filtros
// ═══════════════════════════════════════════════════════════
router.get('/', requireApiKey, (req, res) => {
  const { status, de, ate, cliente, limite = 500 } = req.query;
  const where = [], params = [];

  if (status)  { where.push('status = ?');           params.push(status); }
  if (de)      { where.push('date(criado_em) >= ?'); params.push(de); }
  if (ate)     { where.push('date(criado_em) <= ?'); params.push(ate); }
  if (cliente) { where.push('cliente LIKE ?');        params.push(`%${cliente}%`); }

  const sql = `SELECT * FROM pedidos ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY criado_em DESC LIMIT ?`;
  params.push(Math.min(parseInt(limite) || 500, 5000));
  res.json(db.prepare(sql).all(...params).map(mapRow));
});

// ═══════════════════════════════════════════════════════════
//  DETALHE
// ═══════════════════════════════════════════════════════════
router.get('/:numero', requireApiKey, (req, res) => {
  const p = buscarPedido(req.params.numero);
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado' });
  res.json(p);
});

// ═══════════════════════════════════════════════════════════
//  FLUXO — endpoints semânticos
// ═══════════════════════════════════════════════════════════
router.post('/:numero/aceitar',    requireApiKey, (req, res) => transicionar(req, res, STATUS.IN_PRODUCTION));
router.post('/:numero/rejeitar',   requireApiKey, (req, res) => transicionar(req, res, STATUS.REJECTED));
router.post('/:numero/sair-entrega', requireApiKey, (req, res) => transicionar(req, res, STATUS.OUT_FOR_DELIVERY));
router.post('/:numero/finalizar',  requireApiKey, (req, res) => transicionar(req, res, STATUS.DONE));

// Reativar pedido rejeitado ou finalizado → volta para produção
router.post('/:numero/reativar', requireApiKey, (req, res) => {
  const pedido = buscarPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });

  const { ok, motivo } = canTransition(pedido.status, STATUS.IN_PRODUCTION);
  if (!ok) return res.status(422).json({ erro: motivo });

  db.prepare(`
    UPDATE pedidos
    SET status = 'IN_PRODUCTION',
        motivo_cancelamento = NULL,
        needs_refund = 0,
        atualizado_em = datetime('now')
    WHERE numero = ?
  `).run(req.params.numero);

  const atualizado = buscarPedido(req.params.numero);
  req.io?.to('admin').emit('status_atualizado', atualizado);
  res.json(atualizado);
});

// Cancelar de qualquer estado ativo (inclui IN_PRODUCTION)
router.post('/:numero/cancelar', requireApiKey, (req, res) => transicionar(req, res, STATUS.REJECTED));

// Confirmar que o estorno PIX foi realizado manualmente
router.post('/:numero/marcar-estorno', requireApiKey, (req, res) => {
  const pedido = buscarPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
  if (!pedido.needsRefund) return res.status(422).json({ erro: 'Pedido não requer estorno' });

  db.prepare(`UPDATE pedidos SET needs_refund = 0, atualizado_em = datetime('now') WHERE numero = ?`).run(req.params.numero);
  const atualizado = buscarPedido(req.params.numero);
  req.io?.to('admin').emit('status_atualizado', atualizado);
  return res.json(atualizado);
});

// Ajustar tipo de entrega/bairro em pedido não finalizado
router.patch('/:numero/ajustar', requireApiKey, (req, res) => {
  const pedido = buscarPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });

  if ([STATUS.DONE, STATUS.REJECTED].includes(pedido.status))
    return res.status(422).json({ erro: 'Pedido finalizado não pode ser editado' });

  const { tipoEntrega, endereco, bairroId } = req.body;
  const newTipo  = tipoEntrega ?? pedido.tipoEntrega;

  if (!['retirada', 'entrega'].includes(newTipo))
    return res.status(400).json({ erro: 'Tipo de entrega inválido' });
  if (newTipo === 'entrega' && !endereco?.trim() && !pedido.endereco)
    return res.status(400).json({ erro: 'Endereço obrigatório para entrega' });

  const newEnder  = newTipo === 'retirada' ? null : (endereco?.trim() || pedido.endereco);
  let   newBairro = newTipo === 'retirada' ? null : (bairroId != null ? Number(bairroId) : pedido.bairroId);
  let   novaTaxa  = 0;

  if (newTipo === 'entrega' && newBairro) {
    const b = db.prepare('SELECT taxa_entrega FROM bairros WHERE id = ? AND ativo = 1').get(newBairro);
    if (!b) return res.status(400).json({ erro: 'Bairro não encontrado' });
    novaTaxa = b.taxa_entrega;
  }

  const novoTotal = (pedido.total - (pedido.taxaEntrega ?? 0)) + novaTaxa;

  db.prepare(`
    UPDATE pedidos
    SET tipo_entrega = ?, endereco = ?, bairro_id = ?, taxa_entrega = ?, total = ?, atualizado_em = datetime('now')
    WHERE numero = ?
  `).run(newTipo, newEnder, newBairro, novaTaxa, novoTotal, req.params.numero);

  const atualizado = buscarPedido(req.params.numero);
  req.io?.to('admin').emit('status_atualizado', atualizado);
  return res.json(atualizado);
});

// Confirmar pagamento PIX
router.post('/:numero/confirmar-pagamento', requireApiKey, (req, res) => {
  const pedido = buscarPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });

  if (pedido.paymentMethod !== PAYMENT_METHOD.PIX)
    return res.status(422).json({ erro: 'Apenas pedidos PIX requerem confirmação de pagamento' });
  if (pedido.paymentStatus === PAYMENT_STATUS.CONFIRMED)
    return res.status(422).json({ erro: 'Pagamento já confirmado' });
  if (pedido.status !== STATUS.PENDING_PAYMENT)
    return res.status(422).json({ erro: 'Pedido não está aguardando pagamento' });

  if (pedido.pixExpiraEm && new Date(pedido.pixExpiraEm.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare(`
      UPDATE pedidos SET status = 'REJECTED', motivo_cancelamento = 'expirado_pix', atualizado_em = datetime('now')
      WHERE numero = ?
    `).run(req.params.numero);
    console.log(`[pix] #${req.params.numero} — expirado ao tentar confirmar`);
    return res.status(422).json({ erro: 'PIX expirado. Pedido cancelado automaticamente.' });
  }

  db.prepare(`
    UPDATE pedidos
    SET payment_status = 'CONFIRMED', status = 'PENDING_ACCEPTANCE', atualizado_em = datetime('now')
    WHERE numero = ?
  `).run(req.params.numero);

  const atualizado = buscarPedido(req.params.numero);
  req.io?.to('admin').emit('novo_pedido', atualizado);
  console.log(`[pix] #${req.params.numero} — pagamento confirmado`);
  return res.json(atualizado);
});

// ═══════════════════════════════════════════════════════════
//  RELATÓRIO
// ═══════════════════════════════════════════════════════════
router.get('/relatorio/resumo', requireApiKey, (req, res) => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const hoje = new Date().toISOString().split('T')[0];
  const de   = ISO_DATE.test(req.query.de)  ? req.query.de  : hoje;
  const ate  = ISO_DATE.test(req.query.ate) ? req.query.ate : de;
  if (de > ate) return res.status(400).json({ erro: '"de" deve ser anterior ou igual a "ate"' });

  const ativos = db.prepare(`
    SELECT * FROM pedidos WHERE date(criado_em) BETWEEN ? AND ? AND status != 'REJECTED'
  `).all(de, ate);

  const cancelados = db.prepare(`
    SELECT COUNT(*) as c FROM pedidos
    WHERE date(criado_em) BETWEEN ? AND ? AND status = 'REJECTED'
  `).get(de, ate).c;

  const total = ativos.reduce((s, p) => s + p.total, 0);
  const qtd   = ativos.length;

  // Faturamento por dia (para gráfico de linha)
  const porDia = db.prepare(`
    SELECT date(criado_em) as data, COUNT(*) as pedidos, SUM(total) as faturamento
    FROM pedidos WHERE date(criado_em) BETWEEN ? AND ? AND status != 'REJECTED'
    GROUP BY date(criado_em) ORDER BY data ASC
  `).all(de, ate);

  // Por forma de pagamento
  const porPagamento = {};
  ativos.forEach(p => {
    const k = p.pagamento || 'Outro';
    if (!porPagamento[k]) porPagamento[k] = { qtd: 0, total: 0 };
    porPagamento[k].qtd++;
    porPagamento[k].total += p.total;
  });

  // Entrega vs Retirada
  const tipoEntrega = { entrega: { qtd: 0, total: 0 }, retirada: { qtd: 0, total: 0 } };
  ativos.forEach(p => {
    const k = p.tipo_entrega === 'entrega' ? 'entrega' : 'retirada';
    tipoEntrega[k].qtd++;
    tipoEntrega[k].total += p.total;
  });

  // Itens mais vendidos (marmitas via marmitas_json; bebidas+adicionais via json)
  const itens = {};
  ativos.forEach(p => {
    try {
      const marmitas = p.marmitas_json ? JSON.parse(p.marmitas_json) : [];
      marmitas.forEach(m => {
        (m.itens || []).forEach(i => {
          const qty = i.qty || 1;
          itens[i.nome] = (itens[i.nome] || 0) + qty;
        });
      });
    } catch {}
    try {
      const beb = p.bebidas_json ? JSON.parse(p.bebidas_json) : [];
      beb.forEach(b => { itens[b.nome] = (itens[b.nome] || 0) + (b.quantidade || 1); });
    } catch {}
    try {
      const adic = p.adicionais_json ? JSON.parse(p.adicionais_json) : [];
      adic.forEach(a => { itens[a.nome] = (itens[a.nome] || 0) + (a.quantidade || 1); });
    } catch {}
  });
  const topItens = Object.entries(itens).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([nome, qty]) => ({ nome, qty }));

  // Top clientes
  const topClientes = db.prepare(`
    SELECT cliente, telefone, COUNT(*) as pedidos, SUM(total) as total
    FROM pedidos WHERE date(criado_em) BETWEEN ? AND ? AND status != 'REJECTED'
    GROUP BY telefone ORDER BY pedidos DESC LIMIT 10
  `).all(de, ate);

  // Clientes únicos
  const clientesUnicos = db.prepare(`
    SELECT COUNT(DISTINCT telefone) as c FROM pedidos
    WHERE date(criado_em) BETWEEN ? AND ? AND status != 'REJECTED'
  `).get(de, ate).c;

  res.json({
    periodo:           { de, ate },
    totalFaturado:     total,
    quantidadePedidos: qtd,
    ticketMedio:       qtd > 0 ? total / qtd : 0,
    clientesUnicos,
    cancelados,
    porDia,
    porPagamento,
    tipoEntrega,
    topItens,
    topClientes,
  });
});

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════
function transicionar(req, res, nextStatus) {
  const pedido = buscarPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });

  if (nextStatus === STATUS.OUT_FOR_DELIVERY && pedido.tipoEntrega === 'retirada')
    return res.status(422).json({ erro: 'Pedido de retirada não pode sair para entrega' });

  if (nextStatus === STATUS.DONE && pedido.tipoEntrega === 'entrega' && pedido.status === STATUS.IN_PRODUCTION)
    return res.status(422).json({ erro: 'Pedido de entrega precisa sair para entrega antes de finalizar' });

  if (nextStatus === STATUS.IN_PRODUCTION && pedido.paymentMethod === PAYMENT_METHOD.PIX && pedido.paymentStatus !== PAYMENT_STATUS.CONFIRMED)
    return res.status(422).json({ erro: 'Pagamento ainda não confirmado' });

  const { ok, motivo } = canTransition(pedido.status, nextStatus);
  if (!ok) return res.status(422).json({ erro: motivo });

  if (nextStatus === STATUS.REJECTED) {
    const needsRefund = (
      pedido.paymentMethod === PAYMENT_METHOD.PIX &&
      pedido.paymentStatus === PAYMENT_STATUS.CONFIRMED
    ) ? 1 : 0;
    db.prepare(`
      UPDATE pedidos
      SET status = 'REJECTED', motivo_cancelamento = 'manual', needs_refund = ?, atualizado_em = datetime('now')
      WHERE numero = ?
    `).run(needsRefund, req.params.numero);
  } else {
    db.prepare(`UPDATE pedidos SET status = ?, atualizado_em = datetime('now') WHERE numero = ?`).run(nextStatus, req.params.numero);
  }

  const atualizado = buscarPedido(req.params.numero);
  req.io?.to('admin').emit('status_atualizado', atualizado);
  return res.json(atualizado);
}

function buscarPedido(numero) {
  const r = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
  return r ? mapRow(r) : null;
}

function mapRow(r) {
  return {
    numero:             r.numero,
    cliente:            r.cliente,
    telefone:           r.telefone,
    itens:              JSON.parse(r.itens_json),
    marmitas:           r.marmitas_json    ? JSON.parse(r.marmitas_json)    : [],
    bebidas:            r.bebidas_json     ? JSON.parse(r.bebidas_json)     : [],
    adicionais:         r.adicionais_json  ? JSON.parse(r.adicionais_json)  : [],
    total:              r.total,
    taxaEntrega:        r.taxa_entrega ?? 0,
    bairroId:           r.bairro_id ?? null,
    tipoEntrega:        r.tipo_entrega,
    endereco:           r.endereco,
    pagamento:          r.pagamento,
    paymentMethod:      r.payment_method,
    paymentStatus:      r.payment_status,
    formaPagamento:     r.forma_pagamento,
    momentoPagamento:   r.momento_pagamento,
    pixExpiraEm:            r.pix_expira_em,
    motivoCancelamento:     r.motivo_cancelamento ?? null,
    needsRefund:            r.needs_refund === 1,
    observacao:             r.observacao,
    status:                 r.status,
    criadoEm:           r.criado_em,
    atualizadoEm:       r.atualizado_em,
  };
}

function nomeClienteValido(nome) {
  const t = nome?.trim() ?? '';
  return t.length >= 2 && /[a-zA-ZÀ-ÿ]/.test(t);
}
function telefoneValido(tel) {
  const digits = String(tel).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 11;
}

function validarERecalcularMarmitas(marmitasNorm) {
  let totalGlobal = 0;
  const marmitasValidadas = [];

  const tipoStmt = db.prepare('SELECT * FROM tipos_marmita WHERE id = ? AND ativa = 1');

  // Categorias vinculadas ao produto via N:N
  const catStmt = db.prepare(`
    SELECT c.id, c.nome, c.min_selecao, c.max_selecao, c.obrigatorio
    FROM categorias c
    JOIN categoria_produto cp ON cp.categoria_id = c.id
    WHERE c.ativa = 1 AND cp.produto_id = ?
    ORDER BY c.ordem ASC, c.id ASC
  `);

  // Item válido se pertence a uma categoria vinculada ao produto
  const itemStmt = db.prepare(`
    SELECT ci.id, ci.categoria_id, ci.preco
    FROM cardapio_itens ci
    JOIN categorias cat ON cat.id = ci.categoria_id
    JOIN categoria_produto cp ON cp.categoria_id = cat.id
    WHERE ci.id = ? AND ci.disponivel = 1 AND cat.ativa = 1 AND cp.produto_id = ?
  `);

  for (let mi = 0; mi < marmitasNorm.length; mi++) {
    const m          = marmitasNorm[mi];
    const label      = `Marmita ${mi + 1}`;
    const quantidade = Math.max(1, parseInt(m.quantidade) || 1);
    const tipoId = parseInt(m.produtoId) || 1;

    const tipo = tipoStmt.get(tipoId);
    if (!tipo) return { erro: `${label}: produto #${tipoId} não encontrado` };

    if (!Array.isArray(m.itens) || m.itens.length === 0)
      return { erro: `${label}: sem itens` };

    const precoBase  = tipo.preco;
    const categorias = catStmt.all(tipoId);

    let extrasTotal = 0;
    const countPorCat = {};
    const itensFetched = [];

    for (const itemReq of m.itens) {
      if (!itemReq.id) return { erro: `${label}: item sem id` };
      const qty    = Math.max(1, parseInt(itemReq.qty) || 1);
      const itemDb = itemStmt.get(Number(itemReq.id), tipoId);
      if (!itemDb) return { erro: `${label}: item #${itemReq.id} não encontrado ou indisponível` };
      extrasTotal += itemDb.preco * qty;
      countPorCat[itemDb.categoria_id] = (countPorCat[itemDb.categoria_id] || 0) + qty;
      itensFetched.push({ ...itemReq, qty, preco: itemDb.preco });
    }

    for (const cat of categorias) {
      const count = countPorCat[cat.id] ?? 0;
      const min   = cat.min_selecao ?? 0;
      const max   = cat.max_selecao ?? 1;
      const obrig = cat.obrigatorio !== 0;

      if (obrig && min > 0 && count < min)
        return { erro: `${label}: selecione pelo menos ${min} item(s) em "${cat.nome}"` };
      if (count > max)
        return { erro: `${label}: máximo de ${max} item(s) em "${cat.nome}"` };
    }

    const totalMarmita = precoBase + extrasTotal;
    totalGlobal += totalMarmita * quantidade;
    marmitasValidadas.push({
      tipo:      tipo.nome,
      produtoId: tipoId,
      itens:     itensFetched,
      precoBase,
      total:     totalMarmita,
      quantidade,
      obs:       m.obs?.trim() || null,
    });
  }

  return { erro: null, marmitas: marmitasValidadas, total: totalGlobal };
}

function validarERecalcularItensLivres(itensReq, tipo) {
  if (!Array.isArray(itensReq) || itensReq.length === 0)
    return { erro: null, itens: [], total: 0 };

  const itemStmt = db.prepare(`
    SELECT ci.id, ci.nome, ci.preco
    FROM cardapio_itens ci
    JOIN categorias cat ON cat.id = ci.categoria_id
    WHERE ci.id = ? AND ci.disponivel = 1 AND cat.ativa = 1 AND cat.tipo = ?
  `);

  let total = 0;
  const validados = [];

  for (const req of itensReq) {
    if (!req.id) return { erro: `Item ${tipo} sem id` };
    const qty    = Math.max(1, parseInt(req.quantidade) || 1);
    const itemDb = itemStmt.get(Number(req.id), tipo);
    if (!itemDb) return { erro: `${tipo} #${req.id} não encontrado ou indisponível` };
    total += itemDb.preco * qty;
    validados.push({ id: itemDb.id, nome: itemDb.nome, preco: itemDb.preco, quantidade: qty });
  }

  return { erro: null, itens: validados, total };
}

export default router;
