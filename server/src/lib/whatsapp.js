// src/lib/whatsapp.js
import wwebjs from 'whatsapp-web.js';
import qrcode from 'qrcode';
const { Client, LocalAuth } = wwebjs;

let client = null;
let _io     = null;
let _status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let _qrDataUrl = null;

function normalizarTelefone(tel) {
  let digits = tel.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!digits.startsWith('55')) digits = '55' + digits;
  return `${digits}@c.us`;
}

function criarCliente() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  c.on('qr', async (qr) => {
    _status = 'qr';
    try {
      _qrDataUrl = await qrcode.toDataURL(qr);
    } catch { _qrDataUrl = null; }
    _io?.to('admin').emit('whatsapp_qr', { qr: _qrDataUrl });
    console.log('[whatsapp] QR code gerado — aguardando scan no dashboard');
  });

  c.on('ready', () => {
    _status = 'connected';
    _qrDataUrl = null;
    _io?.to('admin').emit('whatsapp_ready', {});
    console.log('[whatsapp] Conectado com sucesso');
  });

  c.on('auth_failure', (msg) => {
    _status = 'disconnected';
    _qrDataUrl = null;
    _io?.to('admin').emit('whatsapp_disconnected', { reason: 'auth_failure' });
    console.error('[whatsapp] Falha de autenticação:', msg);
  });

  c.on('disconnected', (reason) => {
    _status = 'disconnected';
    _qrDataUrl = null;
    _io?.to('admin').emit('whatsapp_disconnected', { reason });
    console.log('[whatsapp] Desconectado:', reason);
  });

  // Recebe mensagens de clientes (apenas chats individuais, não grupos)
  c.on('message', (msg) => {
    if (msg.from.endsWith('@g.us')) return;
    _io?.to('admin').emit('whatsapp_message', {
      from:      msg.from.replace('@c.us', ''),
      body:      msg.body,
      timestamp: msg.timestamp,
    });
  });

  return c;
}

export function initWhatsApp(io) {
  _io    = io;
  _status = 'connecting';
  client  = criarCliente();
  client.initialize().catch(err => {
    _status = 'disconnected';
    console.error('[whatsapp] Erro na inicialização:', err.message);
  });
}

export async function reconectar() {
  if (client) {
    try { await client.destroy(); } catch { /* ignorar */ }
    client = null;
  }
  _status    = 'connecting';
  _qrDataUrl = null;
  client = criarCliente();
  await client.initialize();
}

export async function desconectar() {
  if (!client) return;
  await client.logout();
  _status    = 'disconnected';
  _qrDataUrl = null;
}

export async function enviarMensagem(telefone, texto) {
  if (_status !== 'connected') throw new Error('WhatsApp não conectado');
  const chatId = normalizarTelefone(telefone);
  await client.sendMessage(chatId, texto);
}

export function getStatus() {
  return { status: _status, qr: _qrDataUrl };
}
