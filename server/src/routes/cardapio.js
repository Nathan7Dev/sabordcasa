// src/routes/cardapio.js
import { Router } from 'express';
import db from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

// Validação de imagem base64 — evita abuso de armazenamento e XSS via data-URI
const MAX_FOTO_BYTES = 250 * 1024; // 250 KB em base64
const FOTO_MIME_RE   = /^data:image\/(jpeg|png|webp);base64,/;

function validarFoto(fotoUrl) {
  if (!fotoUrl) return null;
  if (!FOTO_MIME_RE.test(fotoUrl))
    return 'Formato de imagem inválido. Use JPEG, PNG ou WebP.';
  if (Buffer.byteLength(fotoUrl, 'utf8') > MAX_FOTO_BYTES)
    return `Imagem muito grande. Máximo ${MAX_FOTO_BYTES / 1024} KB.`;
  return null;
}

function emitCardapioAtualizado(req) {
  req.io?.to('admin').emit('cardapio_atualizado');
}

function mapCategoria(r) {
  return {
    id:          r.id,
    nome:        r.nome,
    ordem:       r.ordem,
    ativa:       r.ativa === 1,
    minSelecao:  r.min_selecao ?? 0,
    maxSelecao:  r.max_selecao ?? 1,
    obrigatorio: r.obrigatorio !== 0,
    tipo:        r.tipo ?? 'marmita',
  };
}

function mapItem(r) {
  return {
    id: r.id, categoriaId: r.categoria_id, nome: r.nome,
    descricao: r.descricao, preco: r.preco,
    disponivel: r.disponivel === 1, destaque: r.destaque === 1, ordem: r.ordem,
    fotoUrl: r.foto_url ?? null,
    qtyMax: r.qty_max ?? 1,
  };
}

function mapTipo(r) {
  return {
    id:        r.id,
    nome:      r.nome,
    descricao: r.descricao,
    preco:     r.preco,
    ativa:     r.ativa === 1,
    ordem:     r.ordem,
    fotoUrl:   r.foto_url ?? null,
  };
}

function getProdutosVinculados(categoriaId) {
  return db.prepare('SELECT produto_id FROM categoria_produto WHERE categoria_id = ?')
    .all(categoriaId).map(r => r.produto_id);
}

function categoriaComProdutos(id) {
  const cat = db.prepare('SELECT * FROM categorias WHERE id = ?').get(id);
  if (!cat) return null;
  return { ...mapCategoria(cat), produtosVinculados: getProdutosVinculados(id) };
}

// ═══════════════════════════════════════════════════════════
//  PRODUTOS (tipos_marmita) — público + admin
// ═══════════════════════════════════════════════════════════

router.get('/tipos-marmita', (req, res) => {
  const todos = req.query.todos === '1';
  const sql   = todos
    ? `SELECT * FROM tipos_marmita ORDER BY ordem ASC, id ASC`
    : `SELECT * FROM tipos_marmita WHERE ativa = 1 ORDER BY ordem ASC, id ASC`;
  res.json(db.prepare(sql).all().map(mapTipo));
});

router.post('/tipos-marmita', requireApiKey, (req, res) => {
  const { nome, descricao = null, preco = 0, ativa = 1, ordem = 0, fotoUrl = null } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  if (typeof preco !== 'number' || preco < 0)
    return res.status(400).json({ erro: 'Preço inválido' });
  const erroFoto = validarFoto(fotoUrl);
  if (erroFoto) return res.status(400).json({ erro: erroFoto });

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO tipos_marmita (nome, descricao, preco, ativa, ordem, foto_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nome.trim(), descricao, preco, ativa ? 1 : 0, ordem, fotoUrl || null);

  emitCardapioAtualizado(req);
  res.status(201).json(mapTipo(db.prepare('SELECT * FROM tipos_marmita WHERE id = ?').get(lastInsertRowid)));
});

router.patch('/tipos-marmita/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  const t  = db.prepare('SELECT * FROM tipos_marmita WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ erro: 'Produto não encontrado' });

  const nome    = req.body.nome      !== undefined ? req.body.nome.trim()         : t.nome;
  const desc    = req.body.descricao !== undefined ? req.body.descricao           : t.descricao;
  const preco   = req.body.preco     !== undefined ? Number(req.body.preco)       : t.preco;
  const ativa   = req.body.ativa     !== undefined ? (req.body.ativa ? 1 : 0)     : t.ativa;
  const ordem   = req.body.ordem     !== undefined ? req.body.ordem               : t.ordem;
  const fotoUrl = req.body.fotoUrl   !== undefined ? (req.body.fotoUrl || null)   : t.foto_url;

  if (!nome) return res.status(400).json({ erro: 'Nome não pode ser vazio' });
  if (isNaN(preco) || preco < 0) return res.status(400).json({ erro: 'Preço inválido' });
  if (req.body.fotoUrl !== undefined) {
    const erroFoto = validarFoto(req.body.fotoUrl);
    if (erroFoto) return res.status(400).json({ erro: erroFoto });
  }

  db.prepare(`
    UPDATE tipos_marmita SET nome=?,descricao=?,preco=?,ativa=?,ordem=?,foto_url=? WHERE id=?
  `).run(nome, desc, preco, ativa, ordem, fotoUrl, id);

  emitCardapioAtualizado(req);
  res.json(mapTipo(db.prepare('SELECT * FROM tipos_marmita WHERE id = ?').get(id)));
});

router.delete('/tipos-marmita/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM tipos_marmita WHERE id = ?').get(id))
    return res.status(404).json({ erro: 'Produto não encontrado' });
  // categoria_produto rows são deletados via CASCADE
  db.prepare('DELETE FROM tipos_marmita WHERE id = ?').run(id);
  emitCardapioAtualizado(req);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  PÚBLICO — cardápio ativo para o site
// ═══════════════════════════════════════════════════════════

// ?produto_id=N  → categorias vinculadas ao produto N (nova forma)
// ?tipo=bebida|adicional|marmita → filtro por tipo (compatibilidade)
// sem parâmetros → todas as categorias ativas
router.get('/ativo', (req, res) => {
  const produtoId = req.query.produto_id ? parseInt(req.query.produto_id) : null;
  const tipo      = req.query.tipo ?? null;

  let cats;
  if (produtoId) {
    cats = db.prepare(`
      SELECT c.* FROM categorias c
      JOIN categoria_produto cp ON cp.categoria_id = c.id
      WHERE c.ativa = 1 AND cp.produto_id = ?
      ORDER BY c.ordem ASC, c.id ASC
    `).all(produtoId);
  } else if (tipo) {
    cats = db.prepare(`
      SELECT * FROM categorias WHERE ativa = 1 AND tipo = ?
      ORDER BY ordem ASC, id ASC
    `).all(tipo);
  } else {
    cats = db.prepare(`
      SELECT * FROM categorias WHERE ativa = 1
      ORDER BY ordem ASC, id ASC
    `).all();
  }

  const result = cats.map(cat => {
    const itens = db.prepare(`
      SELECT id, nome, descricao, preco, destaque, foto_url, qty_max
      FROM cardapio_itens
      WHERE categoria_id = ? AND disponivel = 1
      ORDER BY ordem ASC, id ASC
    `).all(cat.id);

    return {
      id:          cat.id,
      nome:        cat.nome,
      minSelecao:  cat.min_selecao ?? 0,
      maxSelecao:  cat.max_selecao ?? 1,
      obrigatorio: cat.obrigatorio !== 0,
      tipo:        cat.tipo ?? 'marmita',
      itens: itens.map(i => ({
        id:        i.id,
        nome:      i.nome,
        descricao: i.descricao,
        preco:     i.preco,
        destaque:  i.destaque === 1,
        fotoUrl:   i.foto_url ?? null,
        qtyMax:    i.qty_max ?? 1,
      })),
    };
  });

  res.json(result);
});

// ═══════════════════════════════════════════════════════════
//  CATEGORIAS — admin
// ═══════════════════════════════════════════════════════════

router.get('/categorias', requireApiKey, (req, res) => {
  const rows = db.prepare(`SELECT * FROM categorias ORDER BY ordem ASC, id ASC`).all();
  res.json(rows.map(r => ({ ...mapCategoria(r), produtosVinculados: getProdutosVinculados(r.id) })));
});

const TIPOS_VALIDOS = ['marmita', 'bebida', 'adicional'];

router.post('/categorias', requireApiKey, (req, res) => {
  const {
    nome, ordem = 0, ativa = 1, minSelecao = 0, maxSelecao = 1,
    obrigatorio = null, tipo = 'marmita', produtoIds = [],
  } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  if (!TIPOS_VALIDOS.includes(tipo))
    return res.status(400).json({ erro: `Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}` });

  const obrigVal = obrigatorio !== null ? (obrigatorio ? 1 : 0) : (minSelecao > 0 ? 1 : 0);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO categorias (nome, ordem, ativa, min_selecao, max_selecao, obrigatorio, tipo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nome.trim(), ordem, ativa ? 1 : 0, minSelecao, maxSelecao, obrigVal, tipo);

  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    const link = db.prepare(`INSERT OR IGNORE INTO categoria_produto (categoria_id, produto_id) VALUES (?,?)`);
    db.transaction(() => { for (const pid of produtoIds) link.run(lastInsertRowid, pid); })();
  }

  emitCardapioAtualizado(req);
  res.status(201).json(categoriaComProdutos(lastInsertRowid));
});

router.patch('/categorias/:id', requireApiKey, (req, res) => {
  const id  = parseInt(req.params.id);
  const cat = db.prepare('SELECT * FROM categorias WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ erro: 'Categoria não encontrada' });

  const nome        = req.body.nome        !== undefined ? req.body.nome.trim()         : cat.nome;
  const ordem       = req.body.ordem       !== undefined ? req.body.ordem               : cat.ordem;
  const ativa       = req.body.ativa       !== undefined ? (req.body.ativa ? 1 : 0)     : cat.ativa;
  const minSelecao  = req.body.minSelecao  !== undefined ? req.body.minSelecao          : cat.min_selecao;
  const maxSelecao  = req.body.maxSelecao  !== undefined ? req.body.maxSelecao          : cat.max_selecao;
  const tipoRaw     = req.body.tipo !== undefined ? req.body.tipo : (cat.tipo ?? 'marmita');
  if (req.body.tipo !== undefined && !TIPOS_VALIDOS.includes(tipoRaw))
    return res.status(400).json({ erro: `Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}` });
  const tipo        = tipoRaw;
  const obrigatorio = req.body.obrigatorio !== undefined
    ? (req.body.obrigatorio ? 1 : 0)
    : (cat.obrigatorio !== null ? cat.obrigatorio : (minSelecao > 0 ? 1 : 0));

  if (!nome) return res.status(400).json({ erro: 'Nome não pode ser vazio' });

  db.prepare(`
    UPDATE categorias SET nome=?,ordem=?,ativa=?,min_selecao=?,max_selecao=?,obrigatorio=?,tipo=? WHERE id=?
  `).run(nome, ordem, ativa, minSelecao, maxSelecao, obrigatorio, tipo, id);

  // Se produtoIds enviado, substitui todos os vínculos
  if (req.body.produtoIds !== undefined) {
    db.transaction(() => {
      db.prepare(`DELETE FROM categoria_produto WHERE categoria_id = ?`).run(id);
      if (Array.isArray(req.body.produtoIds)) {
        const link = db.prepare(`INSERT OR IGNORE INTO categoria_produto (categoria_id, produto_id) VALUES (?,?)`);
        for (const pid of req.body.produtoIds) link.run(id, pid);
      }
    })();
  }

  emitCardapioAtualizado(req);
  res.json(categoriaComProdutos(id));
});

router.delete('/categorias/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM categorias WHERE id = ?').get(id))
    return res.status(404).json({ erro: 'Categoria não encontrada' });
  db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
  emitCardapioAtualizado(req);
  res.json({ ok: true });
});

// Vincular / desvincular produto de uma categoria individualmente
router.post('/categorias/:id/produtos', requireApiKey, (req, res) => {
  const id        = parseInt(req.params.id);
  const produtoId = parseInt(req.body.produtoId);
  if (!db.prepare('SELECT id FROM categorias WHERE id = ?').get(id))
    return res.status(404).json({ erro: 'Categoria não encontrada' });
  if (!produtoId || !db.prepare('SELECT id FROM tipos_marmita WHERE id = ?').get(produtoId))
    return res.status(404).json({ erro: 'Produto não encontrado' });
  db.prepare(`INSERT OR IGNORE INTO categoria_produto (categoria_id, produto_id) VALUES (?,?)`).run(id, produtoId);
  emitCardapioAtualizado(req);
  res.json({ ok: true });
});

router.delete('/categorias/:id/produtos/:produtoId', requireApiKey, (req, res) => {
  const id        = parseInt(req.params.id);
  const produtoId = parseInt(req.params.produtoId);
  db.prepare(`DELETE FROM categoria_produto WHERE categoria_id = ? AND produto_id = ?`).run(id, produtoId);
  emitCardapioAtualizado(req);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  ITENS — admin
// ═══════════════════════════════════════════════════════════

router.get('/itens', requireApiKey, (req, res) => {
  const { categoria_id } = req.query;
  const sql  = categoria_id
    ? `SELECT * FROM cardapio_itens WHERE categoria_id = ? ORDER BY ordem ASC, id ASC`
    : `SELECT * FROM cardapio_itens ORDER BY categoria_id ASC, ordem ASC, id ASC`;
  const rows = categoria_id
    ? db.prepare(sql).all(parseInt(categoria_id))
    : db.prepare(sql).all();
  res.json(rows.map(mapItem));
});

router.post('/itens', requireApiKey, (req, res) => {
  const { categoriaId, nome, descricao = null, preco, disponivel = 1, destaque = 0, ordem = 0, fotoUrl = null, qtyMax = 1 } = req.body;
  if (!categoriaId)                           return res.status(400).json({ erro: 'categoriaId obrigatório' });
  if (!nome?.trim())                          return res.status(400).json({ erro: 'Nome obrigatório' });
  if (typeof preco !== 'number' || preco < 0) return res.status(400).json({ erro: 'Preço inválido' });
  if (!db.prepare('SELECT id FROM categorias WHERE id = ?').get(categoriaId))
    return res.status(400).json({ erro: 'Categoria não encontrada' });
  const erroFoto = validarFoto(fotoUrl);
  if (erroFoto) return res.status(400).json({ erro: erroFoto });

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO cardapio_itens (categoria_id, nome, descricao, preco, disponivel, destaque, ordem, foto_url, qty_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(categoriaId, nome.trim(), descricao, preco, disponivel ? 1 : 0, destaque ? 1 : 0, ordem, fotoUrl || null, Math.max(1, parseInt(qtyMax) || 1));

  emitCardapioAtualizado(req);
  res.status(201).json(mapItem(db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(lastInsertRowid)));
});

router.patch('/itens/:id', requireApiKey, (req, res) => {
  const id   = parseInt(req.params.id);
  const item = db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

  const nome       = req.body.nome        !== undefined ? req.body.nome.trim()          : item.nome;
  const descricao  = req.body.descricao   !== undefined ? req.body.descricao            : item.descricao;
  const preco      = req.body.preco       !== undefined ? req.body.preco                : item.preco;
  const disponivel = req.body.disponivel  !== undefined ? (req.body.disponivel ? 1 : 0) : item.disponivel;
  const destaque   = req.body.destaque    !== undefined ? (req.body.destaque   ? 1 : 0) : item.destaque;
  const ordem      = req.body.ordem       !== undefined ? req.body.ordem                : item.ordem;
  const catId      = req.body.categoriaId !== undefined ? req.body.categoriaId          : item.categoria_id;
  const fotoUrl    = req.body.fotoUrl     !== undefined ? (req.body.fotoUrl || null)    : item.foto_url;
  const qtyMax     = req.body.qtyMax      !== undefined ? Math.max(1, parseInt(req.body.qtyMax) || 1) : (item.qty_max ?? 1);

  if (!nome)                                  return res.status(400).json({ erro: 'Nome não pode ser vazio' });
  if (typeof preco !== 'number' || preco < 0) return res.status(400).json({ erro: 'Preço inválido' });
  if (req.body.fotoUrl !== undefined) {
    const erroFoto = validarFoto(req.body.fotoUrl);
    if (erroFoto) return res.status(400).json({ erro: erroFoto });
  }

  db.prepare(`
    UPDATE cardapio_itens SET categoria_id=?,nome=?,descricao=?,preco=?,disponivel=?,destaque=?,ordem=?,foto_url=?,qty_max=? WHERE id=?
  `).run(catId, nome, descricao, preco, disponivel, destaque, ordem, fotoUrl, qtyMax, id);

  emitCardapioAtualizado(req);
  res.json(mapItem(db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(id)));
});

router.patch('/itens/:id/toggle', requireApiKey, (req, res) => {
  const id   = parseInt(req.params.id);
  const item = db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

  db.prepare('UPDATE cardapio_itens SET disponivel = ? WHERE id = ?').run(item.disponivel === 1 ? 0 : 1, id);
  emitCardapioAtualizado(req);
  req.io?.emit('cardapio_ativo_atualizado');
  res.json(mapItem(db.prepare('SELECT * FROM cardapio_itens WHERE id = ?').get(id)));
});

router.delete('/itens/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM cardapio_itens WHERE id = ?').get(id))
    return res.status(404).json({ erro: 'Item não encontrado' });
  db.prepare('DELETE FROM cardapio_itens WHERE id = ?').run(id);
  emitCardapioAtualizado(req);
  res.json({ ok: true });
});

export default router;
