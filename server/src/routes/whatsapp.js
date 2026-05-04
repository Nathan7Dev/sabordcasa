// src/routes/whatsapp.js
import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { getStatus, desconectar, reconectar, enviarMensagem } from '../lib/whatsapp.js';

const router = Router();

// Status atual + QR base64 se em estado 'qr'
router.get('/status', requireApiKey, (_req, res) => {
  res.json(getStatus());
});

// Reinicializar cliente (exibe novo QR se sessão expirou)
router.post('/reconectar', requireApiKey, async (_req, res) => {
  try {
    await reconectar();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Desconectar e encerrar sessão
router.post('/desconectar', requireApiKey, async (_req, res) => {
  try {
    await desconectar();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Enviar mensagem manual para um cliente pelo dashboard
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
