// Simula um atendente (o que o IoT MQTT Panel faz) para testar sem celular.
// Uso: npm run simular [-- mesa cliente]   |   BROKER_URL=mqtt://localhost:1883 npm run simular
const fs = require('fs'), path = require('path'), mqtt = require('mqtt');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const P = process.env.PREFIXO || cfg.prefixo;
const AT = process.env.ATENDENTE || 'teste';
const [mesa = '7', cliente = 'Maria Silva'] = process.argv.slice(2);
const c = mqtt.connect(process.env.BROKER_URL || cfg.broker.url);
const t = (x) => `${P}/at/${AT}/${x}`;
const passos = [
  ['mesa', mesa], ['cliente', cliente],
  ['item', 'BBB-BACON'], ['qtd', '2'], ['add', '1'],
  ['item', 'HEINEKEN600'], ['qtd', '1'], ['add', '1'],
  ['item', 'CAM-MIL'], ['add', '1'],
  ['obs', 'Sem cebola no hambúrguer'], ['enviar', '1'],
];
c.on('connect', () => {
  c.subscribe([t('resumo'), t('status')]);
  let i = 0;
  const next = () => {
    if (i >= passos.length) return setTimeout(() => c.end(), 800);
    const [k, v] = passos[i++]; console.log('>', k, v); c.publish(t(k), v); setTimeout(next, 250);
  };
  next();
});
c.on('message', (tp, m) => console.log(`< ${tp.split('/').pop()}:\n${m.toString().replace(/^/gm, '    ')}`));
