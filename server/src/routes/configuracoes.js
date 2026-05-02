// src/routes/configuracoes.js
import { Router } from 'express';
import db from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

// GET /api/configuracoes/loja-aberta — público (site e dashboard consultam)
router.get('/loja-aberta', (req, res) => {
  const cfg = db.prepare(`SELECT valor FROM configuracoes WHERE chave = 'loja_aberta'`).get();
  res.json({ aberta: cfg?.valor !== '0' });
});

// POST /api/configuracoes/loja-aberta — admin
router.post('/loja-aberta', requireApiKey, (req, res) => {
  const { aberta } = req.body;
  if (typeof aberta !== 'boolean') return res.status(400).json({ erro: 'Campo "aberta" (boolean) obrigatório' });

  const valor = aberta ? '1' : '0';
  db.prepare(`INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('loja_aberta', ?)`).run(valor);

  // Broadcast para todos os clientes (site e dashboard)
  req.io?.emit('loja_status', { aberta });
  console.log(`[loja] status alterado: ${aberta ? 'ABERTA' : 'FECHADA'}`);
  res.json({ aberta });
});

export default router;
