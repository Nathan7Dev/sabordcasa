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
  const puppeteerOpts = {
    headless: true,
    protocolTimeout: 20000, // Puppeteer falha em 20s em vez dos 180s padrão
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  // Em produção/Docker usa o Chromium do sistema via PUPPETEER_EXECUTABLE_PATH
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: puppeteerOpts,
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

  c.on('message', (msg) => {
    if (msg.from.endsWith('@g.us')) return;       // grupos
    if (msg.from === 'status@broadcast') return;  // stories/status do WhatsApp
    _io?.to('admin').emit('whatsapp_message', {
      from:      msg.from.replace('@c.us', ''),
      body:      msg.body,
      timestamp: msg.timestamp,
    });
  });

  return c;
}

function _iniciarCliente() {
  client.initialize().catch(err => {
    _status = 'disconnected';
    _io?.to('admin').emit('whatsapp_disconnected', { reason: err.message });
    console.error('[whatsapp] Erro ao inicializar:', err.message);
  });
}

export function initWhatsApp(io) {
  _io     = io;
  _status = 'connecting';
  client  = criarCliente();
  _iniciarCliente();
}

// Destrói o cliente atual e reinicializa — resultado chega via socket (qr/ready/disconnected)
export async function reconectar() {
  if (client) {
    try { await client.destroy(); } catch { /* ignorar */ }
    client = null;
  }
  _status    = 'connecting';
  _qrDataUrl = null;
  client = criarCliente();
  _iniciarCliente(); // fire-and-forget — não bloqueia a rota HTTP
}

export async function desconectar() {
  if (!client) return;
  await client.logout();
  _status    = 'disconnected';
  _qrDataUrl = null;
}

// Verifica se o cliente está realmente funcional (não só o _status local)
export async function verificarConexao() {
  if (!client || _status !== 'connected') return false;
  try {
    const state = await Promise.race([
      client.getState(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const ok = state === 'CONNECTED';
    if (!ok) {
      console.warn(`[whatsapp] getState() retornou "${state}" — marcando como desconectado`);
      _status = 'disconnected';
      _io?.to('admin').emit('whatsapp_disconnected', { reason: `estado: ${state}` });
    }
    return ok;
  } catch {
    console.warn('[whatsapp] getState() travou — sessão provavelmente morta');
    _status = 'disconnected';
    _io?.to('admin').emit('whatsapp_disconnected', { reason: 'sessão inresponsiva' });
    return false;
  }
}

export async function enviarMensagem(telefone, texto) {
  if (_status !== 'connected') throw new Error('WhatsApp não conectado');

  // Garante que o cliente está realmente vivo antes de tentar
  const vivo = await verificarConexao();
  if (!vivo) throw new Error('Sessão do WhatsApp não está ativa — reconecte pelo dashboard');

  const chatId = normalizarTelefone(telefone);
  console.log(`[whatsapp] enviando para ${chatId}`);

  try {
    await client.sendMessage(chatId, texto);
  } catch (err) {
    console.error(`[whatsapp] sendMessage falhou (${chatId}):`, err.message);
    // Sessão travada — reconecta automaticamente para o próximo envio
    if (err.message.includes('timed out') || err.message.includes('timeout')) {
      console.warn('[whatsapp] sessão instável detectada — reconectando em background');
      _status = 'disconnected';
      _io?.to('admin').emit('whatsapp_disconnected', { reason: 'sessão instável — reconectando' });
      reconectar().catch(e => console.error('[whatsapp] falha ao reconectar:', e.message));
    }
    throw err;
  }

  console.log(`[whatsapp] mensagem enviada para ${chatId}`);
  const digits = telefone.replace(/\D/g, '');
  _io?.to('admin').emit('whatsapp_sent', { to: digits, body: texto, timestamp: Date.now() / 1000 });
}

export function getStatus() {
  return { status: _status, qr: _qrDataUrl };
}
