// src/lib/whatsapp.js — integração via Evolution API (Baileys, sem Puppeteer)
let _io     = null;
let _status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let _qrDataUrl = null;

const BASE = () => (process.env.EVOLUTION_API_URL ?? '').replace(/\/$/, '');
const KEY  = () => process.env.EVOLUTION_API_KEY ?? '';
const INST = () => process.env.EVOLUTION_INSTANCE ?? 'sabordcasa';
const ativo = () => !!(BASE() && KEY());

function headers() {
  return { apikey: KEY(), 'Content-Type': 'application/json' };
}

function normalizarTelefone(tel) {
  let d = tel.replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('55')) d = '55' + d;
  return d;
}

async function apiFetch(path, opts = {}) {
  const r = await fetch(`${BASE()}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers ?? {}) } });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message ?? `Evolution API ${r.status}`);
  }
  return r.json().catch(() => ({}));
}

// Cria a instância e configura o webhook uma única vez
async function garantirInstancia() {
  const lista = await apiFetch('/instance/fetchInstances').catch(() => []);
  const existe = Array.isArray(lista) && lista.some(i => i.instance?.instanceName === INST());
  if (existe) return;

  const webhookUrl = process.env.SERVER_URL
    ? `${process.env.SERVER_URL}/api/webhooks/evolution`
    : null;

  await apiFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName: INST(),
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      ...(webhookUrl ? {
        webhook: {
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'],
        },
      } : {}),
    }),
  });
  console.log(`[whatsapp] instância "${INST()}" criada`);
}

async function sincronizarStatus() {
  const lista = await apiFetch('/instance/fetchInstances').catch(() => []);
  const inst  = Array.isArray(lista) && lista.find(i => i.instance?.instanceName === INST());
  if (!inst) return;
  const state = inst.instance?.state ?? inst.instance?.connectionStatus;
  if (state === 'open') {
    _status = 'connected';
    _io?.to('admin').emit('whatsapp_ready', {});
  } else {
    _status = 'disconnected';
  }
}

// ─── Inicialização ────────────────────────────────────────────────────────────
export async function initWhatsApp(io) {
  _io = io;
  if (!ativo()) {
    console.warn('[whatsapp] EVOLUTION_API_URL / EVOLUTION_API_KEY não configurados — módulo desabilitado');
    return;
  }
  try {
    await garantirInstancia();
    await sincronizarStatus();
    console.log(`[whatsapp] status inicial: ${_status}`);
  } catch (err) {
    console.error('[whatsapp] erro na inicialização:', err.message);
  }
}

// ─── Reconectar (exibe QR se necessário) ─────────────────────────────────────
export async function reconectar() {
  if (!ativo()) throw new Error('Evolution API não configurada');
  _status    = 'connecting';
  _qrDataUrl = null;
  try {
    await garantirInstancia();
    const data = await apiFetch(`/instance/connect/${INST()}`);
    if (data.base64) {
      _status    = 'qr';
      _qrDataUrl = data.base64;
      _io?.to('admin').emit('whatsapp_qr', { qr: _qrDataUrl });
    } else {
      // Já estava conectado
      await sincronizarStatus();
    }
  } catch (err) {
    _status = 'disconnected';
    _io?.to('admin').emit('whatsapp_disconnected', { reason: err.message });
    throw err;
  }
}

// ─── Desconectar ──────────────────────────────────────────────────────────────
export async function desconectar() {
  if (!ativo()) return;
  await apiFetch(`/instance/logout/${INST()}`, { method: 'DELETE' }).catch(() => {});
  _status    = 'disconnected';
  _qrDataUrl = null;
}

// ─── Enviar mensagem ──────────────────────────────────────────────────────────
export async function enviarMensagem(telefone, texto) {
  if (!ativo()) throw new Error('Evolution API não configurada');
  if (_status !== 'connected') throw new Error('WhatsApp não conectado');

  const number = normalizarTelefone(telefone);
  await apiFetch(`/message/sendText/${INST()}`, {
    method: 'POST',
    body: JSON.stringify({ number, text: texto }),
  });

  const digits = telefone.replace(/\D/g, '');
  _io?.to('admin').emit('whatsapp_sent', { to: digits, body: texto, timestamp: Date.now() / 1000 });
}

// ─── Status atual ─────────────────────────────────────────────────────────────
export function getStatus() {
  return { status: ativo() ? _status : 'disabled', qr: _qrDataUrl };
}

// ─── Processamento de eventos vindos do webhook da Evolution API ───────────────
export function handleEvolutionWebhook(event, data) {
  if (event === 'qrcode.updated') {
    _status    = 'qr';
    _qrDataUrl = data?.qrcode?.base64 ?? null;
    _io?.to('admin').emit('whatsapp_qr', { qr: _qrDataUrl });

  } else if (event === 'connection.update') {
    const state = data?.state ?? data?.instance?.state;
    if (state === 'open') {
      _status    = 'connected';
      _qrDataUrl = null;
      _io?.to('admin').emit('whatsapp_ready', {});
      console.log('[whatsapp] conectado via Evolution API');
    } else if (state === 'close') {
      _status    = 'disconnected';
      _qrDataUrl = null;
      _io?.to('admin').emit('whatsapp_disconnected', { reason: 'conexão encerrada' });
    }

  } else if (event === 'messages.upsert') {
    // Ignora mensagens enviadas pela própria conta e grupos
    if (data?.key?.fromMe) return;
    const jid = data?.key?.remoteJid ?? '';
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const from = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    const body =
      data?.message?.conversation ??
      data?.message?.extendedTextMessage?.text ??
      '';
    if (!body) return;

    _io?.to('admin').emit('whatsapp_message', {
      from,
      body,
      timestamp: Number(data?.messageTimestamp ?? Date.now() / 1000),
    });
  }
}
