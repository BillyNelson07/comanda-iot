// Gateway de comandas: recebe os comandos do IoT MQTT Panel, monta o pedido,
// publica para o ESP32 (impressão) e para a plataforma web, e guarda o histórico.
const fs = require('fs');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const BY_COD = Object.fromEntries(MENU.map((i) => [i.cod, i]));
const P = process.env.PREFIXO || cfg.prefixo;
const BROKER = process.env.BROKER_URL || cfg.broker.url;
const WS_URL = process.env.BROKER_WS || cfg.broker.wsUrl;
const PORT = process.env.PORT || cfg.porta;
const DATA = path.join(__dirname, 'data', 'orders.json');

let orders = [];
try { orders = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { /* primeiro uso */ }
let seq = orders.reduce((m, o) => Math.max(m, o.id), 0);
const carts = {};
const r2 = (n) => Math.round(n * 100) / 100;
const brl = (n) => n.toFixed(2).replace('.', ',');

// ---------- MQTT ----------
const client = mqtt.connect(BROKER, {
  clientId: 'comanda-gateway-' + Math.random().toString(16).slice(2, 8),
  reconnectPeriod: 2000,
  will: { topic: `${P}/gateway/status`, payload: 'offline', retain: true, qos: 1 },
});
const pub = (t, m, o = {}) => client.publish(`${P}/${t}`, typeof m === 'string' ? m : JSON.stringify(m), o);

client.on('connect', () => {
  console.log(`[mqtt] conectado em ${BROKER} | prefixo "${P}"`);
  client.subscribe([`${P}/at/+/+`, `${P}/cmd`], { qos: 1 });
  pub('gateway/status', 'online', { retain: true, qos: 1 });
  publishOrders();
});
client.on('error', (e) => console.error('[mqtt] erro:', e.message));
client.on('message', (topic, buf) => {
  const parts = topic.slice(P.length + 1).split('/');
  const msg = buf.toString('utf8');
  try {
    if (parts[0] === 'at' && parts.length === 2 + 1) onWaiter(parts[1], parts[2], msg);
    else if (parts[0] === 'cmd') onCommand(JSON.parse(msg));
  } catch (e) { console.error('[erro]', topic, e.message); }
});

// ---------- Atendentes (IoT MQTT Panel) ----------
const cartOf = (id) => (carts[id] ||= { mesa: '', cliente: '', item: '', qtd: 1, obs: '', itens: [] });
const say = (id, m) => pub(`at/${id}/status`, m);

function parseItem(c, v) {
  const m = v.toUpperCase().replace(/\s+/g, '').match(/^(?:(\d+)[X*])?([A-Z0-9-]+?)(?:[:X*](\d+))?$/);
  if (!m || !BY_COD[m[2]]) return false;
  c.item = m[2];
  if (m[1] || m[3]) c.qtd = Math.min(99, parseInt(m[1] || m[3], 10));
  return true;
}

function onWaiter(id, campo, raw) {
  const v = raw.trim();
  const c = cartOf(id);
  switch (campo) {
    case 'mesa': c.mesa = v.slice(0, 10); break;
    case 'cliente': c.cliente = v.slice(0, 40); break;
    case 'qtd': c.qtd = Math.max(1, Math.min(99, parseInt(v, 10) || 1)); break;
    case 'obs': c.obs = v.slice(0, 200); break;
    case 'item': if (!parseItem(c, v)) return say(id, `Item desconhecido: ${v}`); break;
    case 'add': {
      const it = BY_COD[c.item];
      if (!it) return say(id, 'Escolha um item antes de adicionar');
      const line = c.itens.find((x) => x.cod === it.cod);
      if (line) { line.qtd += c.qtd; line.subtotal = r2(line.qtd * line.preco); }
      else c.itens.push({ cod: it.cod, nome: it.nome, preco: it.preco, qtd: c.qtd, subtotal: r2(c.qtd * it.preco) });
      say(id, `Adicionado: ${c.qtd}x ${it.nome}`);
      break;
    }
    case 'undo': c.itens.pop(); break;
    case 'limpar': delete carts[id]; return resumo(id);
    case 'enviar': return submit(id, c);
    case 'pedido': return submit(id, JSON.parse(v), true); // pedido completo em JSON
    default: return;
  }
  resumo(id);
}

function resumo(id) {
  const c = carts[id] || cartOf(id);
  const total = r2(c.itens.reduce((s, i) => s + i.subtotal, 0));
  const l = [`Mesa ${c.mesa || '?'} | ${c.cliente || '(sem nome)'}`];
  c.itens.forEach((i) => l.push(`${i.qtd}x ${i.nome}  R$ ${brl(i.subtotal)}`));
  if (!c.itens.length) l.push('(sem itens)');
  if (c.obs) l.push(`Obs: ${c.obs}`);
  l.push(`TOTAL R$ ${brl(total)}`);
  pub(`at/${id}/resumo`, l.join('\n'));
}

function submit(id, c, json = false) {
  let itens = c.itens;
  if (json) {
    itens = (c.itens || []).map((x) => {
      const it = BY_COD[String(x.cod).toUpperCase()];
      if (!it) throw new Error(`item ${x.cod}`);
      const qtd = Math.max(1, parseInt(x.qtd, 10) || 1);
      return { cod: it.cod, nome: it.nome, preco: it.preco, qtd, subtotal: r2(qtd * it.preco) };
    });
  }
  const faltam = [!c.mesa && 'mesa', !c.cliente && 'cliente', !itens.length && 'itens'].filter(Boolean);
  if (faltam.length) return say(id, `Faltou: ${faltam.join(', ')}`);
  const order = {
    id: ++seq, mesa: String(c.mesa), cliente: c.cliente, atendente: id, obs: c.obs || '', itens,
    total: r2(itens.reduce((s, i) => s + i.subtotal, 0)),
    status: 'novo', criado: new Date().toISOString(),
  };
  orders.push(order);
  delete carts[id];
  save();
  pub('pedidos/novo', order, { qos: 1 });
  printOrder('cozinha', order);
  if (cfg.imprimirCaixaQuando === 'novo') printOrder('caixa', order);
  publishOrders();
  say(id, `Pedido #${order.id} enviado - Mesa ${order.mesa} - R$ ${brl(order.total)}`);
  resumo(id);
  console.log(`[pedido] #${order.id} mesa ${order.mesa} ${order.cliente} R$ ${brl(order.total)}`);
}

// ---------- Plataforma web (comandos) ----------
function onCommand({ id, acao, pgto, canal }) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  const now = new Date().toISOString();
  if (acao === 'preparo' && o.status === 'novo') { o.status = 'preparo'; o.t_preparo = now; }
  else if (acao === 'pronto' && ['novo', 'preparo'].includes(o.status)) {
    o.status = 'pronto'; o.t_pronto = now;
    if (cfg.imprimirCaixaQuando === 'pronto') printOrder('caixa', o);
  } else if (acao === 'pago' && o.status === 'pronto') { o.status = 'pago'; o.t_pago = now; o.pgto = pgto || ''; }
  else if (acao === 'cancelar' && !['pago', 'cancelado'].includes(o.status)) { o.status = 'cancelado'; o.t_cancel = now; }
  else if (acao === 'reimprimir') printOrder(canal === 'cozinha' ? 'cozinha' : 'caixa', o);
  else return;
  save();
  publishOrders();
}

function printOrder(canal, o) {
  const d = new Date(o.criado);
  const p2 = (n) => String(n).padStart(2, '0');
  pub(`print/${canal}`, {
    est: cfg.estabelecimento, id: o.id, mesa: o.mesa, cli: o.cliente, at: o.atendente, obs: o.obs, tot: o.total,
    d: `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`, h: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
    it: o.itens.map((i) => ({ q: i.qtd, n: i.nome, p: i.preco })),
  }, { qos: 1 });
}

const save = () => fs.writeFileSync(DATA, JSON.stringify(orders.slice(-1000)));
const publishOrders = () => pub('orders', orders.slice(-150), { retain: true, qos: 1 });

// ---------- HTTP: serve a plataforma web ----------
const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.js') {
    const host = (req.headers.host || 'localhost').split(':')[0];
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.COMANDA=${JSON.stringify({ nome: cfg.estabelecimento, prefixo: P, ws: WS_URL.replace('{host}', host) })};`);
  }
  if (url.pathname === '/mqtt.min.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return fs.createReadStream(path.join(__dirname, 'node_modules/mqtt/dist/mqtt.min.js')).pipe(res);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    return req.on('end', () => {
      let u = null;
      try { const b = JSON.parse(body); u = cfg.usuarios.find((x) => x.usuario === b.usuario && x.pin === String(b.pin)); } catch { /* inválido */ }
      res.writeHead(u ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(u ? { usuario: u.usuario, papel: u.papel } : { erro: 'Usuário ou PIN inválido' }));
    });
  }
  const file = path.normalize(path.join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`[web] http://localhost:${PORT}`));
