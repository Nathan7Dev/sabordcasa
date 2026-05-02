// src/db/schema.js
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_PATH = process.env.DB_PATH || join(__dirname, '../../data/sabordcasa.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema base (fresh install) ──────────────────────────────────────────────
db.exec(`
  -- tipos_marmita representa produtos independentes (Marmita P, Bebidas, Adicionais, etc.)
  CREATE TABLE IF NOT EXISTS tipos_marmita (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nome      TEXT    NOT NULL,
    descricao TEXT,
    preco     REAL    NOT NULL DEFAULT 0,
    ativa     INTEGER NOT NULL DEFAULT 1,
    ordem     INTEGER NOT NULL DEFAULT 0,
    foto_url  TEXT
  );

  CREATE TABLE IF NOT EXISTS bairros (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nome         TEXT    NOT NULL UNIQUE,
    taxa_entrega REAL    NOT NULL DEFAULT 0,
    ativo        INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_bairros_ativo ON bairros(ativo);

  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('loja_aberta', '1');

  CREATE TABLE IF NOT EXISTS pedidos (
    numero              TEXT PRIMARY KEY,
    cliente             TEXT NOT NULL,
    telefone            TEXT NOT NULL,
    itens_json          TEXT NOT NULL,
    total               REAL NOT NULL,
    tipo_entrega        TEXT NOT NULL CHECK(tipo_entrega IN ('retirada','entrega')),
    endereco            TEXT,
    pagamento           TEXT NOT NULL,
    payment_method      TEXT NOT NULL CHECK(payment_method  IN ('PIX','CASH')),
    payment_status      TEXT NOT NULL CHECK(payment_status  IN ('PENDING','CONFIRMED','FAILED','NOT_APPLICABLE')),
    observacao          TEXT,
    status              TEXT NOT NULL CHECK(status IN (
                          'PENDING_PAYMENT','PENDING_ACCEPTANCE','REJECTED',
                          'IN_PRODUCTION','OUT_FOR_DELIVERY','DONE'
                        )),
    criado_em           TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em       TEXT NOT NULL DEFAULT (datetime('now')),
    marmitas_json       TEXT,
    bebidas_json        TEXT,
    adicionais_json     TEXT,
    forma_pagamento     TEXT,
    momento_pagamento   TEXT,
    pix_expira_em       TEXT,
    motivo_cancelamento TEXT CHECK(motivo_cancelamento IN ('manual','expirado_pix')),
    needs_refund        INTEGER NOT NULL DEFAULT 0,
    bairro_id           INTEGER,
    taxa_entrega        REAL    NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_pedidos_status         ON pedidos(status);
  CREATE INDEX IF NOT EXISTS idx_pedidos_payment_status ON pedidos(payment_status);
  CREATE INDEX IF NOT EXISTS idx_pedidos_criado         ON pedidos(criado_em);
  CREATE INDEX IF NOT EXISTS idx_pedidos_cliente        ON pedidos(cliente);
  CREATE INDEX IF NOT EXISTS idx_pedidos_telefone       ON pedidos(telefone);

  CREATE TABLE IF NOT EXISTS categorias (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    ordem       INTEGER NOT NULL DEFAULT 0,
    ativa       INTEGER NOT NULL DEFAULT 1 CHECK(ativa IN (0,1)),
    min_selecao INTEGER NOT NULL DEFAULT 0,
    max_selecao INTEGER NOT NULL DEFAULT 1,
    obrigatorio INTEGER NOT NULL DEFAULT 1,
    tipo        TEXT    NOT NULL DEFAULT 'marmita'
  );

  -- N:N: categorias ↔ produtos
  CREATE TABLE IF NOT EXISTS categoria_produto (
    categoria_id INTEGER NOT NULL REFERENCES categorias(id)    ON DELETE CASCADE,
    produto_id   INTEGER NOT NULL REFERENCES tipos_marmita(id) ON DELETE CASCADE,
    PRIMARY KEY (categoria_id, produto_id)
  );

  CREATE TABLE IF NOT EXISTS cardapio_itens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
    nome         TEXT    NOT NULL,
    descricao    TEXT,
    preco        REAL    NOT NULL CHECK(preco >= 0),
    disponivel   INTEGER NOT NULL DEFAULT 1 CHECK(disponivel IN (0,1)),
    destaque     INTEGER NOT NULL DEFAULT 0 CHECK(destaque IN (0,1)),
    ordem        INTEGER NOT NULL DEFAULT 0,
    foto_url     TEXT,
    qty_max      INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_itens_categoria  ON cardapio_itens(categoria_id);
  CREATE INDEX IF NOT EXISTS idx_itens_disponivel ON cardapio_itens(disponivel);

  CREATE TABLE IF NOT EXISTS clientes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nome      TEXT    NOT NULL,
    telefone  TEXT    NOT NULL UNIQUE,
    criado_em TEXT    NOT NULL DEFAULT (datetime('now')),
    ultimo_em TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes(telefone);

  CREATE TABLE IF NOT EXISTS contador (
    chave TEXT PRIMARY KEY,
    valor INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO contador (chave, valor) VALUES ('pedido', 0);
`);

// ─── Migrações ────────────────────────────────────────────────────────────────
runMigrations();

function runMigrations() {
  const colsCat = db.pragma('table_info(categorias)').map(c => c.name);
  if (!colsCat.includes('min_selecao'))  migrateAddSelecao();
  if (!colsCat.includes('tipo'))         migrateAddTipoCategoria();
  if (!colsCat.includes('obrigatorio'))  migrateAddObrigatorioCategoria();

  const colsTipos = db.pragma('table_info(tipos_marmita)').map(c => c.name);
  if (!colsTipos.includes('foto_url'))    migrateAddFotoUrl();

  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  if (!tabelas.includes('clientes')) migrateAddClientes();

  const colsItem = db.pragma('table_info(cardapio_itens)').map(c => c.name);
  if (!colsItem.includes('foto_url'))     migrateAddItemFotoUrl();
  if (!colsItem.includes('qty_max'))      migrateAddItemQtyMax();

  const p = db.pragma('table_info(pedidos)').map(c => c.name);
  if (!p.includes('marmitas_json'))       migrateAddMarmitasJson();
  if (!p.includes('forma_pagamento'))     migrateAddPagamentoV2();
  if (!p.includes('motivo_cancelamento')) migrateAddMotivoCancelamento();
  if (!p.includes('needs_refund'))        migrateAddNeedsRefund();
  if (!p.includes('bairro_id'))           migrateAddBairro();
  if (!p.includes('bebidas_json'))        migrateAddBebidasJson();
  if (!p.includes('adicionais_json'))     migrateAddAdicionaisJson();
}

// ─── Migrações retroativas ────────────────────────────────────────────────────
function migrateAddFotoUrl() {
  db.exec(`ALTER TABLE tipos_marmita ADD COLUMN foto_url TEXT`);
  console.log('[db] migração: foto_url adicionado a tipos_marmita');
}
function migrateAddClientes() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nome      TEXT    NOT NULL,
      telefone  TEXT    NOT NULL UNIQUE,
      criado_em TEXT    NOT NULL DEFAULT (datetime('now')),
      ultimo_em TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes(telefone);
  `);
  console.log('[db] migração: tabela clientes criada');
}
function migrateAddItemFotoUrl() {
  db.exec(`ALTER TABLE cardapio_itens ADD COLUMN foto_url TEXT`);
  console.log('[db] migração: foto_url adicionado a cardapio_itens');
}
function migrateAddItemQtyMax() {
  db.exec(`ALTER TABLE cardapio_itens ADD COLUMN qty_max INTEGER NOT NULL DEFAULT 1`);
  console.log('[db] migração: qty_max adicionado a cardapio_itens');
}
function migrateAddObrigatorioCategoria() {
  db.exec(`ALTER TABLE categorias ADD COLUMN obrigatorio INTEGER DEFAULT 1`);
  db.exec(`UPDATE categorias SET obrigatorio=0 WHERE min_selecao=0 OR min_selecao IS NULL`);
  console.log('[db] migração: obrigatorio adicionado a categorias');
}
function migrateAddBebidasJson() {
  db.exec(`ALTER TABLE pedidos ADD COLUMN bebidas_json TEXT`);
  console.log('[db] migração: bebidas_json adicionado');
}
function migrateAddAdicionaisJson() {
  db.exec(`ALTER TABLE pedidos ADD COLUMN adicionais_json TEXT`);
  console.log('[db] migração: adicionais_json adicionado');
}
function migrateAddMarmitasJson() {
  db.exec(`ALTER TABLE pedidos ADD COLUMN marmitas_json TEXT`);
  console.log('[db] migração: marmitas_json adicionado');
}
function migrateAddPagamentoV2() {
  db.exec(`
    ALTER TABLE pedidos ADD COLUMN forma_pagamento   TEXT;
    ALTER TABLE pedidos ADD COLUMN momento_pagamento TEXT;
    ALTER TABLE pedidos ADD COLUMN pix_expira_em     TEXT;
  `);
  console.log('[db] migração: campos pagamento v2 adicionados');
}
function migrateAddMotivoCancelamento() {
  db.exec(`ALTER TABLE pedidos ADD COLUMN motivo_cancelamento TEXT`);
  console.log('[db] migração: motivo_cancelamento adicionado');
}
function migrateAddNeedsRefund() {
  db.exec(`ALTER TABLE pedidos ADD COLUMN needs_refund INTEGER NOT NULL DEFAULT 0`);
  console.log('[db] migração: needs_refund adicionado');
}
function migrateAddBairro() {
  db.exec(`
    ALTER TABLE pedidos ADD COLUMN bairro_id    INTEGER;
    ALTER TABLE pedidos ADD COLUMN taxa_entrega REAL NOT NULL DEFAULT 0;
  `);
  console.log('[db] migração: bairro_id e taxa_entrega adicionados');
}
function migrateAddSelecao() {
  db.exec(`
    ALTER TABLE categorias ADD COLUMN min_selecao INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE categorias ADD COLUMN max_selecao INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('[db] migração: min/max_selecao adicionados a categorias');
}
function migrateAddTipoCategoria() {
  db.exec(`ALTER TABLE categorias ADD COLUMN tipo TEXT NOT NULL DEFAULT 'marmita'`);
  console.log('[db] migração: tipo adicionado a categorias');
}

export default db;
