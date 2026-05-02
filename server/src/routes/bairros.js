// src/routes/bairros.js
import { Router } from 'express';
import db from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

function mapBairro(r) {
  return { id: r.id, nome: r.nome, taxaEntrega: r.taxa_entrega, ativo: r.ativo === 1 };
}

// GET /api/bairros — público (site usa para preencher selector)
// ?todos=1 exige autenticação válida para ver inativos
router.get('/', (req, res) => {
  const isAdmin = req.headers['x-api-key'] === process.env.ADMIN_API_KEY;
  const todos   = req.query.todos === '1' && isAdmin;
  const sql = todos
    ? `SELECT * FROM bairros ORDER BY nome ASC`
    : `SELECT * FROM bairros WHERE ativo = 1 ORDER BY nome ASC`;
  res.json(db.prepare(sql).all().map(mapBairro));
});

router.post('/', requireApiKey, (req, res) => {
  const { nome, taxaEntrega = 0, ativo = 1 } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
  if (typeof taxaEntrega !== 'number' || taxaEntrega < 0)
    return res.status(400).json({ erro: 'Taxa de entrega inválida' });

  try {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bairros (nome, taxa_entrega, ativo) VALUES (?, ?, ?)
    `).run(nome.trim(), taxaEntrega, ativo ? 1 : 0);
    res.status(201).json(mapBairro(db.prepare('SELECT * FROM bairros WHERE id = ?').get(lastInsertRowid)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ erro: 'Bairro já cadastrado' });
    throw e;
  }
});

router.patch('/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  const b  = db.prepare('SELECT * FROM bairros WHERE id = ?').get(id);
  if (!b) return res.status(404).json({ erro: 'Bairro não encontrado' });

  const nome       = req.body.nome        !== undefined ? req.body.nome.trim()                    : b.nome;
  const taxa       = req.body.taxaEntrega !== undefined ? Number(req.body.taxaEntrega)             : b.taxa_entrega;
  const ativo      = req.body.ativo       !== undefined ? (req.body.ativo ? 1 : 0)                : b.ativo;

  if (!nome) return res.status(400).json({ erro: 'Nome não pode ser vazio' });
  if (isNaN(taxa) || taxa < 0) return res.status(400).json({ erro: 'Taxa inválida' });

  db.prepare(`UPDATE bairros SET nome = ?, taxa_entrega = ?, ativo = ? WHERE id = ?`).run(nome, taxa, ativo, id);
  res.json(mapBairro(db.prepare('SELECT * FROM bairros WHERE id = ?').get(id)));
});

router.delete('/:id', requireApiKey, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM bairros WHERE id = ?').get(id))
    return res.status(404).json({ erro: 'Bairro não encontrado' });
  db.prepare('DELETE FROM bairros WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
