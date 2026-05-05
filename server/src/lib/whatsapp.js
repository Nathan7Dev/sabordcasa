// src/lib/whatsapp.js — integração via Evolution API (Baileys, sem Puppeteer)
let _io     = null;
let _status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let _qrDataUrl = null;

const BASE       = () => (process.env.EVOLUTION_API_URL ?? '').replace(/\/+$/, '');
const SERVER_URL = () => (process.env.SERVER_URL ?? '').replace(/\/+$/, '');
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

function webhookUrl() {
  const base = SERVER_URL();
  return base ? `${base}/api/webhooks/evolution` : null;
}

async function atualizarWebhook() {
  const url = webhookUrl();
  if (!url) return;
  // Evolution API v2: body direto com "enabled"
  const body = JSON.stringify({
    url,
    enabled: true,
    events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'],
  });
  try {
    await apiFetch(`/webhook/set/${INST()}`, { method: 'POST', body });
    console.log(`[whatsapp] webhook atualizado → ${url}`);
  } catch (err) {
    console.warn('[whatsapp] falha /webhook/set:', err.message, '— tentando /webhook/', INST());
    try {
      await apiFetch(`/webhook/${INST()}`, { method: 'PUT', body });
      console.log(`[whatsapp] webhook atualizado via PUT → ${url}`);
    } catch (err2) {
      console.warn('[whatsapp] falha ao atualizar webhook:', err2.message);
    }
  }
}

// Cria a instância se não existir; sempre atualiza o webhook
// Evolution API v2 usa "name"; v1 usa "instanceName" ou "instance.instanceName"
function nomeInstancia(item) {
  return item?.name ?? item?.instanceName ?? item?.instance?.instanceName ?? null;
}
function estadoInstancia(item) {
  return item?.connectionStatus ?? item?.instance?.state ?? item?.instance?.connectionStatus ?? null;
}

async function garantirInstancia() {
  const lista = await apiFetch('/instance/fetchInstances').catch(err => {
    console.error('[whatsapp] fetchInstances falhou:', err.message);
    return [];
  });
  // Log do JSON bruto para diagnóstico
  console.log('[whatsapp] fetchInstances raw:', JSON.stringify(lista));

  const arr   = Array.isArray(lista) ? lista : (lista ? [lista] : []);
  const nomes = arr.map(nomeInstancia);
  console.log('[whatsapp] nomes detectados:', JSON.stringify(nomes));
  const existe = nomes.includes(INST());

  if (existe) {
    console.log(`[whatsapp] instância "${INST()}" encontrada — atualizando webhook`);
    await atualizarWebhook();
    return;
  }

  // Tenta criar; se receber 409/403 = já existe, só atualiza webhook
  const url = webhookUrl();
  console.log(`[whatsapp] criando instância "${INST()}" — webhook: ${url}`);
  try {
    const resp = await apiFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: INST(),
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        ...(url ? { webhook: { url, byEvents: false, base64: false,
          events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'] } } : {}),
      }),
    });
    console.log('[whatsapp] instância criada:', JSON.stringify(resp));
  } catch (err) {
    if (err.message.includes('403') || err.message.includes('409')) {
      console.log('[whatsapp] instância já existe (403/409) — atualizando webhook');
      await atualizarWebhook();
    } else {
      throw err;
    }
  }
}

async function sincronizarStatus() {
  const lista = await apiFetch('/instance/fetchInstances').catch(() => []);
  const inst  = Array.isArray(lista) && lista.find(i => nomeInstancia(i) === INST());
  if (!inst) return;
  const state = estadoInstancia(inst);
  console.log(`[whatsapp] estado atual da instância: ${state}`);
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
    console.log('[whatsapp] /instance/connect resposta:', JSON.stringify(data));

    // Evolution API v2 pode retornar o QR em diferentes estruturas
    const qrBase64 =
      data?.base64 ??
      data?.qrcode?.base64 ??
      data?.qr?.base64 ??
      (typeof data?.code === 'string' && data.code.startsWith('data:') ? data.code : null);

    if (qrBase64) {
      _status    = 'qr';
      _qrDataUrl = qrBase64;
      _io?.to('admin').emit('whatsapp_qr', { qr: _qrDataUrl });
      console.log('[whatsapp] QR emitido para o dashboard');
    } else {
      console.log('[whatsapp] sem QR na resposta — sincronizando status');
      await sincronizarStatus();
    }
  } catch (err) {
    _status = 'disconnected';
    console.error('[whatsapp] reconectar falhou:', err.message);
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
  const ev = (event ?? '').toLowerCase().replace(/_/g, '.');
  console.log(`[whatsapp] webhook recebido: ${event}`);
  if (ev === 'qrcode.updated') {
    _status    = 'qr';
    _qrDataUrl = data?.qrcode?.base64 ?? null;
    _io?.to('admin').emit('whatsapp_qr', { qr: _qrDataUrl });

  } else if (ev === 'connection.update') {
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

  } else if (ev === 'messages.upsert') {
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
