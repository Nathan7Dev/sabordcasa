// src/index.js
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SITE_DIR   = process.env.SITE_DIR || join(__dirname, '../../site');

import './db/schema.js';
import { iniciarAgendamentoLimpeza } from './db/cleanup.js';

import pedidosRouter       from './routes/pedidos.js';
import cardapioRouter      from './routes/cardapio.js';
import bairrosRouter       from './routes/bairros.js';
import configuracoesRouter from './routes/configuracoes.js';
import clientesRouter      from './routes/clientes.js';
import webhooksRouter      from './routes/webhooks.js';

// ─── Verificação de segurança na inicialização ────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? '';
if (!ADMIN_KEY || ADMIN_KEY.length < 32) {
  console.error('\n⛔  ADMIN_API_KEY ausente ou fraca (< 32 chars).');
  console.error('    Gere uma chave forte: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('    E coloque no arquivo .env\n');
  process.exit(1);
}

// ─── Origens permitidas (CORS) ────────────────────────────────────────────────
const ORIGENS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5500,http://localhost:3000,http://127.0.0.1:5500')
  .split(',').map(o => o.trim());

const corsOptions = {
  origin: (origin, cb) => {
    // Permite requests sem origin (ex: curl, Postman durante dev) apenas em dev
    // origin === 'null' ocorre quando a página é aberta via file:// no browser
    if ((!origin || origin === 'null') && process.env.NODE_ENV !== 'production') return cb(null, true);
    if (!origin || ORIGENS.includes(origin)) return cb(null, true);
    cb(new Error(`Origem não permitida: ${origin}`));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
  credentials: true,
};

const app  = express();
const http = createServer(app);
const io   = new Server(http, {
  cors: {
    origin: (origin, cb) => {
      if ((!origin || origin === 'null') && process.env.NODE_ENV !== 'production') return cb(null, true);
      if (!origin || ORIGENS.includes(origin)) return cb(null, true);
      cb(new Error(`Origem não permitida: ${origin}`));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  },
});

// ─── Rate limiters (desativados em desenvolvimento) ───────────────────────────
const DEV  = process.env.NODE_ENV !== 'production';
const skip = () => DEV;  // pula o limiter inteiro fora de produção

const limitePublico = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  skip,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Aguarde alguns minutos.' },
});

const limitePedido = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skip,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos enviados. Aguarde 15 minutos.' },
});

const limiteAdmin = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  skip,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erro: 'Rate limit atingido. Aguarde 1 minuto.' },
});

// ─── Arquivos estáticos — antes do helmet para não aplicar CSP nos HTMLs ─────
app.use(express.static(SITE_DIR));

// ─── Middleware de segurança (API) ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", 'https://cdn.jsdelivr.net'],
      connectSrc:  ["'self'", ...ORIGENS, 'ws:', 'wss:'],
      imgSrc:      ["'self'", 'data:', 'https://images.unsplash.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight

app.use(express.json({ limit: '512kb' }));

// Morgan: apenas em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
} else {
  // Em produção: loga apenas erros — sem dados pessoais
  app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
}

app.use((req, _res, next) => { req.io = io; next(); });

// ─── Rotas ───────────────────────────────────────────────────────────────────
app.get('/api', (_req, res) => {
  res.json({ servico: "Sabor D'Casa API", status: 'online' });
});

// Webhook do Mercado Pago — fora dos rate limiters de admin
app.use('/api/webhooks', webhooksRouter);

// Rotas públicas com rate limit restritivo
app.use('/api/pedidos',           limitePedido);           // POST / criação
app.use('/api/clientes/registrar', limitePublico);
app.use('/api/cardapio/ativo',    limitePublico);
app.use('/api/configuracoes/loja-aberta', limitePublico);
app.use('/api/bairros',           limitePublico);

// Todas as rotas admin com rate limit moderado
app.use('/api',                   limiteAdmin);

app.use('/api/pedidos',       pedidosRouter);
app.use('/api/cardapio',      cardapioRouter);
app.use('/api/bairros',       bairrosRouter);
app.use('/api/configuracoes', configuracoesRouter);
app.use('/api/clientes',      clientesRouter);

// 404 genérico — sem stack trace
app.use((_req, res) => res.status(404).json({ erro: 'Endpoint não encontrado' }));

// Error handler global — captura erros de CORS e outros sem vazar stack
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('Origem não permitida')) {
    return res.status(403).json({ erro: 'Origem não autorizada' });
  }
  // Em produção não expõe a mensagem de erro interna
  const msg = process.env.NODE_ENV !== 'production' ? err.message : 'Erro interno';
  res.status(err.status ?? 500).json({ erro: msg });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
// Rate limit de autenticação por socket (brute force protection)
const wsAuthAttempts = new Map(); // socketId → { count, resetAt }

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    wsAuthAttempts.delete(socket.id);
  });

  socket.on('identificar_admin', (key) => {
    const now = Date.now();
    const entry = wsAuthAttempts.get(socket.id) ?? { count: 0, resetAt: now + 60_000 };

    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
    entry.count++;
    wsAuthAttempts.set(socket.id, entry);

    if (entry.count > 8) {
      socket.emit('erro_auth', 'Muitas tentativas. Tente em 1 minuto.');
      return socket.disconnect(true);
    }

    if (typeof key === 'string' && key === ADMIN_KEY) {
      socket.join('admin');
      socket.emit('admin_autenticado', { ok: true });
      wsAuthAttempts.delete(socket.id); // reset após sucesso
    } else {
      socket.emit('admin_autenticado', { ok: false });
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  const env = process.env.NODE_ENV ?? 'development';
  console.log(`\n🍱  Sabor D'Casa — API [${env}] — porta ${PORT}\n`);
  iniciarAgendamentoLimpeza();
});

http.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n⛔  Porta ${PORT} já está em uso. Outro processo Node está rodando.`);
    console.error(`    Para liberar no Windows: abra o Gerenciador de Tarefas → aba Detalhes → encerre "node.exe"`);
    console.error(`    Ou feche qualquer terminal que esteja com o servidor já rodando.\n`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGTERM', () => { http.close(() => process.exit(0)); });
process.on('SIGINT',  () => { http.close(() => process.exit(0)); });
