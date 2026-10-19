(() => {
  const C = window.COMANDA, P = C.prefixo;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  let orders = [], user = null, known = null, selUser = '';

  document.title = C.nome + ' · Comandas';
  $('#nome').textContent = C.nome;

  // ---------- MQTT (WebSocket) ----------
  const chip = (id, on) => $(id).classList.toggle('on', !!on);
  const mq = mqtt.connect(C.ws, { clientId: 'web-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 2000 });
  mq.on('connect', () => { chip('#c-broker', 1); mq.subscribe([`${P}/orders`, `${P}/gateway/status`, `${P}/print/status`]); });
  mq.on('close', () => { chip('#c-broker', 0); chip('#c-gw', 0); chip('#c-prn', 0); });
  mq.on('message', (t, b) => {
    const m = b.toString();
    if (t.endsWith('/gateway/status')) return chip('#c-gw', m === 'online');
    if (t.endsWith('/print/status')) return chip('#c-prn', m === 'online');
    orders = JSON.parse(m);
    const ids = new Set(orders.map((o) => o.id));
    if (known && user?.papel === 'cozinha' && orders.some((o) => !known.has(o.id) && o.status === 'novo')) beep();
    known = ids;
    render();
  });
  const cmd = (id, acao, extra = {}) => mq.publish(`${P}/cmd`, JSON.stringify({ id, acao, ...extra }), { qos: 1 });

  function beep() {
    try {
      const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.setValueAtTime(.2, a.currentTime);
      g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .6); o.start(); o.stop(a.currentTime + .6);
    } catch { /* áudio bloqueado até o primeiro clique */ }
  }

  // ---------- Login ----------
  $('#roles').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    selUser = b.dataset.u;
    document.querySelectorAll('#roles button').forEach((x) => x.classList.toggle('sel', x === b));
    $('#pin').focus();
  });
  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selUser) return ($('#erro').textContent = 'Escolha Cozinha, Caixa ou Gerência.');
    const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ usuario: selUser, pin: $('#pin').value }) });
    if (!r.ok) return ($('#erro').textContent = 'PIN incorreto.');
    user = await r.json(); sessionStorage.setItem('user', JSON.stringify(user)); enter();
  });
  $('#sair').onclick = () => { sessionStorage.clear(); location.reload(); };
  function enter() {
    $('#login').hidden = true; $('#sair').hidden = false; $('#papel').textContent = user.papel;
    ['cozinha', 'caixa', 'gerencia'].forEach((v) => ($(`#v-${v}`).hidden = v !== user.papel));
    render();
  }
  try { user = JSON.parse(sessionStorage.getItem('user')); } catch { /* sem sessão */ }
  if (user) enter();

  // ---------- Renderização ----------
  const age = (iso) => {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    return { m, cls: m >= 20 ? 'l' : m >= 10 ? 'w' : '', txt: m < 1 ? 'agora' : m + ' min' };
  };
  const head = (o, a) => `<div class="hd"><div class="mesa"><small>Mesa</small>${esc(o.mesa)}</div>
    <div class="who"><b>${esc(o.cliente)}</b>#${o.id} · ${hhmm(o.criado)} · ${esc(o.atendente)}</div>
    <span class="age ${a.cls}">${a.txt}</span></div>`;
  const obs = (o) => (o.obs ? `<div class="obs">⚠ ${esc(o.obs)}</div>` : '');

  function render() {
    if (!user) return;
    if (user.papel === 'cozinha') {
      for (const s of ['novo', 'preparo']) {
        const list = orders.filter((o) => o.status === s);
        $('#n-' + s).textContent = list.length;
        $('#l-' + s).innerHTML = list.map((o) => {
          const a = age(o.criado);
          return `<article class="card ${s}${a.m >= 20 ? ' late' : ''}">${head(o, a)}
            <ul>${o.itens.map((i) => `<li><span class="q">${i.qtd}×</span>${esc(i.nome)}</li>`).join('')}</ul>${obs(o)}
            <div class="acts">${s === 'novo'
              ? `<button class="warn grow" data-a="preparo" data-id="${o.id}">Iniciar preparo</button>`
              : ''}<button class="ok grow" data-a="pronto" data-id="${o.id}">Pronto ✓</button></div></article>`;
        }).join('') || '<div class="vazio">Nenhum pedido aqui.</div>';
      }
    }
    if (user.papel === 'caixa') {
      const list = orders.filter((o) => o.status === 'pronto');
      const pagos = orders.filter((o) => o.status === 'pago');
      $('#n-pronto').textContent = list.length;
      $('#k-caixa').innerHTML = kpi('A receber', brl(sum(list))) + kpi('Recebido (histórico)', brl(sum(pagos))) + kpi('Contas pagas', pagos.length);
      $('#l-pronto').innerHTML = list.map((o) => `<article class="card pronto">${head(o, age(o.criado))}
        <ul>${o.itens.map((i) => `<li><span class="q">${i.qtd}×</span>${esc(i.nome)}<span class="p">${brl(i.preco)} · ${brl(i.subtotal)}</span></li>`).join('')}</ul>${obs(o)}
        <div class="total">Total<b>${brl(o.total)}</b></div>
        <div class="acts"><select data-pg="${o.id}"><option>Pix</option><option>Dinheiro</option><option>Crédito</option><option>Débito</option></select>
        <button class="ok grow" data-a="pago" data-id="${o.id}">Receber</button>
        <button class="ghost" data-a="reimprimir" data-id="${o.id}">🖨</button></div></article>`).join('') || '<div class="vazio">Nenhuma conta pronta para cobrança.</div>';
    }
    if (user.papel === 'gerencia') renderGer();
  }
  const sum = (l) => l.reduce((s, o) => s + o.total, 0);
  const kpi = (l, v) => `<div class="kpi"><small>${l}</small><b>${v}</b></div>`;

  // ---------- Gerência ----------
  const F = () => Object.fromEntries(new FormData($('#filtros')));
  const filtered = () => {
    const f = F();
    return orders.filter((o) => {
      const t = new Date(o.criado), hm = t.getHours() * 60 + t.getMinutes();
      const mins = (s) => (s ? +s.slice(0, 2) * 60 + +s.slice(3) : null);
      return (!f.mesa || o.mesa === f.mesa.trim()) && (!f.cli || o.cliente.toLowerCase().includes(f.cli.toLowerCase())) &&
        (!f.status || o.status === f.status) && (!f.vmin || o.total >= +f.vmin) && (!f.vmax || o.total <= +f.vmax) &&
        (!f.de || hm >= mins(f.de)) && (!f.ate || hm <= mins(f.ate));
    }).sort((a, b) => b.id - a.id);
  };
  const open = new Set();
  function renderGer() {
    const list = filtered(), valid = list.filter((o) => o.status !== 'cancelado');
    $('#k-ger').innerHTML = kpi('Pedidos', list.length) + kpi('Faturamento', brl(sum(valid))) +
      kpi('Ticket médio', brl(valid.length ? sum(valid) / valid.length : 0)) +
      kpi('Em aberto', list.filter((o) => ['novo', 'preparo', 'pronto'].includes(o.status)).length);
    $('#tb tbody').innerHTML = list.map((o) => `<tr class="row" data-id="${o.id}"><td>${o.id}</td><td>${hhmm(o.criado)}</td><td>${esc(o.mesa)}</td>
      <td>${esc(o.cliente)}</td><td>${esc(o.atendente)}</td><td><span class="st ${o.status}">${o.status}</span></td><td class="r">${brl(o.total)}</td></tr>
      ${open.has(o.id) ? `<tr class="det"><td colspan="7"><ul style="margin:0;padding-left:18px">${o.itens.map((i) => `<li>${i.qtd}× ${esc(i.nome)} — ${brl(i.preco)} = ${brl(i.subtotal)}</li>`).join('')}</ul>
      ${o.obs ? `<p class="obs">⚠ ${esc(o.obs)}</p>` : ''}${o.pgto ? `<p>Pagamento: ${esc(o.pgto)}</p>` : ''}
      ${['novo', 'preparo', 'pronto'].includes(o.status) ? `<button class="danger" data-a="cancelar" data-id="${o.id}">Cancelar pedido</button>` : ''}</td></tr>` : ''}`).join('');
  }
  $('#filtros').addEventListener('input', renderGer);
  $('#filtros').addEventListener('reset', () => setTimeout(renderGer));
  $('#tb').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const tr = e.target.closest('tr.row'); if (!tr) return;
    const id = +tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); renderGer();
  });
  $('#csv').onclick = () => {
    const rows = [['id', 'data_hora', 'mesa', 'cliente', 'atendente', 'status', 'total', 'itens']].concat(filtered().map((o) =>
      [o.id, o.criado, o.mesa, o.cliente, o.atendente, o.status, o.total.toFixed(2), o.itens.map((i) => `${i.qtd}x ${i.nome}`).join(' | ')]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = 'pedidos.csv'; a.click();
  };

  // ---------- Ações dos botões ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const id = +b.dataset.id, extra = {};
    if (b.dataset.a === 'pago') extra.pgto = document.querySelector(`[data-pg="${id}"]`)?.value;
    if (b.dataset.a === 'cancelar' && !confirm(`Cancelar o pedido #${id}?`)) return;
    cmd(id, b.dataset.a, extra);
  });
  setInterval(() => user && user.papel !== 'gerencia' && render(), 30000); // atualiza os cronômetros
})();
