// src/routes/whatsapp.js
import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { getStatus, desconectar, reconectar, enviarMensagem, verificarConexao } from '../lib/whatsapp.js';

const router = Router();

// Status atual + QR base64 se em estado 'qr'
// Inclui verificação real via getState() do Puppeteer
router.get('/status', requireApiKey, async (_req, res) => {
  const s = getStatus();
  if (s.status === 'connected') {
    const vivo = await verificarConexao();
    if (!vivo) s.status = 'disconnected';
  }
  res.json(s);
});

// Reinicializar cliente — responde imediatamente; resultado chega via socket (qr/ready/disconnected)
router.post('/reconectar', requireApiKey, (_req, res) => {
  reconectar().catch(() => { /* já tratado dentro do reconectar() */ });
  res.json({ ok: true });
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
