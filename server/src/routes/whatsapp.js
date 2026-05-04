// src/routes/whatsapp.js
import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { getStatus, reconectar, desconectar, enviarMensagem } from '../lib/whatsapp.js';

const router = Router();

router.get('/status', requireApiKey, (_req, res) => {
  res.json(getStatus());
});

router.post('/reconectar', requireApiKey, (req, res) => {
  const { status } = getStatus();
  if (status === 'disabled')
    return res.status(503).json({ erro: 'Evolution API não configurada — defina EVOLUTION_API_URL e EVOLUTION_API_KEY nas variáveis do Railway' });
  res.json({ ok: true }); // responde imediatamente; resultado chega via socket
  reconectar().catch(err => console.error('[whatsapp] reconectar:', err.message));
});

router.post('/desconectar', requireApiKey, async (_req, res) => {
  try {
    await desconectar();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

router.post('/enviar', requireApiKey, async (req, res) => {
  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem?.trim())
    return res.status(400).json({ erro: 'telefone e mensagem são obrigatórios' });
  try {
    await enviarMensagem(telefone, mensagem.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ erro: err.message });
  }
});

export default router;
