/**
 * Olho D'Água — backend básico de demonstração.
 *
 * O que este arquivo entrega, de verdade (não simulado):
 *  - Uma API HTTP real (sem frameworks externos, só o módulo "http" do Node)
 *  - Um banco de dados SQLite real, gravado em disco (data/olho-dagua.db),
 *    usando o módulo nativo "node:sqlite" do Node 22+ (não precisa instalar nada)
 *  - Armazenamento de fotos em disco (pasta /uploads), servidas por HTTP —
 *    é o mesmo padrão de um bucket de nuvem (S3, Cloud Storage etc.):
 *    a API decide onde o arquivo mora e guarda só a URL no banco.
 *    Trocar por um bucket de nuvem de verdade depois é só trocar a função
 *    savePhoto() por uma chamada ao SDK do provedor escolhido.
 *
 * Limitações propositais desta demo (ver README.md):
 *  - Sem autenticação real (qualquer um pode dizer que é qualquer cliente)
 *  - Sem HTTPS, sem rate limiting, sem validação de tamanho/tipo de arquivo
 *  - Banco local em arquivo único, não pensado para produção/escala
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Em produção, defina STORAGE_DIR para o ponto de montagem do volume persistente
// (ex.: /data no Railway). Localmente, continua usando a pasta do projeto.
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : ROOT;
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const DB_PATH = path.join(STORAGE_DIR, 'data', 'olho-dagua.db');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---------- BANCO DE DADOS ----------
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    addr TEXT NOT NULL,
    sev TEXT NOT NULL,
    pts INTEGER NOT NULL,
    description TEXT,
    photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'analise',
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    cost INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

const rewardCount = db.prepare('SELECT COUNT(*) AS n FROM rewards').get().n;
if (rewardCount === 0) {
  const seed = db.prepare('INSERT INTO rewards (name, description, cost, active) VALUES (?, ?, ?, 1)');
  seed.run('Redutor de vazão para torneira', 'Brinde enviado pelos Correios', 50);
  seed.run('Kit economia de água', 'Arejadores + fita veda-rosca', 80);
  seed.run('10% de desconto na fatura', 'Aplicado na próxima fatura', 100);
  seed.run('Visita técnica gratuita', 'Verificação de vazamento interno', 150);
  seed.run('Isenção da taxa de religação', 'Válida em caso de corte', 200);
  seed.run('25% de desconto em 3 faturas', 'Nos 3 próximos ciclos', 350);
}

const SEV_PTS = { leve: 10, moderado: 20, grave: 35 };

// ---------- HELPERS ----------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 15 * 1024 * 1024) { // limite básico: 15MB por requisição
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Salva uma foto enviada como data URL base64 ("data:image/jpeg;base64,...").
// Padrão idêntico ao de um upload para bucket de nuvem: recebe bytes, grava,
// devolve uma URL. Só a implementação de "onde grava" muda no futuro.
function savePhoto(dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const ext = match[1].split('/')[1].replace('jpeg', 'jpg');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const buffer = Buffer.from(match[2], 'base64');
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

function tierOf(points) {
  const tiers = [['BRONZE', 0], ['PRATA', 100], ['OURO', 250], ['PLATINA', 500]];
  let t = tiers[0][0];
  for (const [name, min] of tiers) if (points >= min) t = name;
  return t;
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(req, res, baseDir, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(baseDir, safePath);
  if (!filePath.startsWith(baseDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- SERVIDOR ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // -------- Arquivos estáticos --------
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      return serveStatic(req, res, UPLOADS_DIR, pathname.replace('/uploads/', ''));
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const filePath = pathname === '/' ? '/index.html' : pathname;
      return serveStatic(req, res, PUBLIC_DIR, filePath);
    }

    // -------- Health check para a hospedagem --------
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: "olho-dagua" });
    }

    // -------- API: onboarding de cliente --------
    if (req.method === 'POST' && pathname === '/api/onboard') {
      const { name } = await readJsonBody(req);
      if (!name || !name.trim()) return sendJson(res, 400, { error: 'nome é obrigatório' });
      const id = name.trim().toLowerCase().replace(/\s+/g, '-');
      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
      if (!existing) db.prepare('INSERT INTO clients (id, name, points) VALUES (?, ?, 0)').run(id, name.trim());
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
      return sendJson(res, 200, client);
    }

    // -------- API: listar clientes --------
    if (req.method === 'GET' && pathname === '/api/clients') {
      const clients = db.prepare('SELECT * FROM clients ORDER BY points DESC').all();
      return sendJson(res, 200, clients.map(c => ({ ...c, tier: tierOf(c.points) })));
    }

    // -------- API: criar denúncia --------
    if (req.method === 'POST' && pathname === '/api/reports') {
      const b = await readJsonBody(req);
      if (!b.clientId || !b.addr || !b.sev) return sendJson(res, 400, { error: 'campos obrigatórios: clientId, addr, sev' });
      const pts = SEV_PTS[b.sev] || 10;
      const photoUrl = b.photoBase64 ? savePhoto(b.photoBase64) : null;
      const stmt = db.prepare(`INSERT INTO reports (client_id, client_name, addr, sev, pts, description, photo_url, status, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, 'analise', ?)`);
      const info = stmt.run(b.clientId, b.clientName || b.clientId, b.addr, b.sev, pts, b.description || '', photoUrl, new Date().toISOString());
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid);
      return sendJson(res, 201, report);
    }

    // -------- API: listar denúncias (opcionalmente por cliente ou status) --------
    if (req.method === 'GET' && pathname === '/api/reports') {
      const clientId = url.searchParams.get('clientId');
      const status = url.searchParams.get('status');
      let sql = 'SELECT * FROM reports';
      const clauses = [], params = [];
      if (clientId) { clauses.push('client_id = ?'); params.push(clientId); }
      if (status) { clauses.push('status = ?'); params.push(status); }
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql += ' ORDER BY id DESC';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    // -------- API: confirmar/rejeitar denúncia --------
    const reportMatch = pathname.match(/^\/api\/reports\/(\d+)$/);
    if (req.method === 'PATCH' && reportMatch) {
      const id = Number(reportMatch[1]);
      const { status, reason } = await readJsonBody(req);
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
      if (!report) return sendJson(res, 404, { error: 'denúncia não encontrada' });
      if (report.status !== 'analise') return sendJson(res, 409, { error: 'denúncia já foi analisada' });
      db.prepare('UPDATE reports SET status = ?, reason = ? WHERE id = ?').run(status, reason || null, id);
      if (status === 'confirmado') {
        db.prepare('UPDATE clients SET points = points + ? WHERE id = ?').run(report.pts, report.client_id);
      }
      return sendJson(res, 200, db.prepare('SELECT * FROM reports WHERE id = ?').get(id));
    }

    // -------- API: listar recompensas --------
    if (req.method === 'GET' && pathname === '/api/rewards') {
      return sendJson(res, 200, db.prepare('SELECT * FROM rewards ORDER BY cost ASC').all());
    }

    // -------- API: criar recompensa --------
    if (req.method === 'POST' && pathname === '/api/rewards') {
      const b = await readJsonBody(req);
      if (!b.name || !b.cost) return sendJson(res, 400, { error: 'campos obrigatórios: name, cost' });
      const info = db.prepare('INSERT INTO rewards (name, description, cost, active) VALUES (?, ?, ?, 1)')
        .run(b.name, b.description || '', Number(b.cost));
      return sendJson(res, 201, db.prepare('SELECT * FROM rewards WHERE id = ?').get(info.lastInsertRowid));
    }

    // -------- API: editar recompensa --------
    const rewardMatch = pathname.match(/^\/api\/rewards\/(\d+)$/);
    if (req.method === 'PATCH' && rewardMatch) {
      const id = Number(rewardMatch[1]);
      const b = await readJsonBody(req);
      const current = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
      if (!current) return sendJson(res, 404, { error: 'recompensa não encontrada' });
      db.prepare('UPDATE rewards SET name = ?, description = ?, cost = ?, active = ? WHERE id = ?').run(
        b.name ?? current.name, b.description ?? current.description,
        b.cost ?? current.cost, b.active === undefined ? current.active : (b.active ? 1 : 0), id
      );
      return sendJson(res, 200, db.prepare('SELECT * FROM rewards WHERE id = ?').get(id));
    }

    // -------- API: excluir recompensa --------
    if (req.method === 'DELETE' && rewardMatch) {
      db.prepare('DELETE FROM rewards WHERE id = ?').run(Number(rewardMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // -------- API: resgatar recompensa --------
    if (req.method === 'POST' && pathname === '/api/redeem') {
      const { clientId, rewardId } = await readJsonBody(req);
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(rewardId);
      if (!client || !reward) return sendJson(res, 404, { error: 'cliente ou recompensa não encontrados' });
      if (client.points < reward.cost) return sendJson(res, 400, { error: 'pontos insuficientes' });
      db.prepare('UPDATE clients SET points = points - ? WHERE id = ?').run(reward.cost, clientId);
      return sendJson(res, 200, db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId));
    }

    sendJson(res, 404, { error: 'rota não encontrada' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'erro interno', detail: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Olho D'Água backend rodando em http://${HOST}:${PORT}`);
  console.log(`Banco de dados: ${DB_PATH}`);
  console.log(`Fotos salvas em: ${UPLOADS_DIR}`);
});
