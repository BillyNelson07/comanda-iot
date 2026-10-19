/*
  Comanda Printer — ESP32 DevKit V1 + impressora térmica 80 mm (ESC/POS) via Bluetooth
  Recebe pedidos por MQTT e imprime em dois canais:
    <PREFIXO>/print/cozinha  -> via de preparo (sem preços)
    <PREFIXO>/print/caixa    -> conta para cobrança
  Bibliotecas (Gerenciador de Bibliotecas): PubSubClient (Nick O'Leary), ArduinoJson 7.x
  Placa: "ESP32 Dev Module"  |  Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
*/
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <BluetoothSerial.h>

// ====== CONFIGURE AQUI ======
const char* WIFI_SSID    = "SUA_REDE_WIFI";
const char* WIFI_PASS    = "SUA_SENHA_WIFI";
const char* MQTT_HOST    = "broker.hivemq.com";   // ou o IP do PC com o broker local
const uint16_t MQTT_PORT = 1883;
const char* PREFIXO      = "bdb-TROQUE-ESTE-CODIGO"; // IGUAL ao "prefixo" do server/config.json
const char* PRINTER_NAME = "GoldemSky";           // nome Bluetooth que a impressora anuncia (veja no celular)
const uint8_t LINE_W     = 48;                    // colunas (80 mm, fonte A = 48; use 42 se cortar)
const uint8_t CODEPAGE   = 19;                    // ESC t n: 19 = CP858; se acentos saírem errados tente 2 (CP850)
// ============================

BluetoothSerial BT;
WiFiClient net;
PubSubClient mqtt(net);
String topicCozinha, topicCaixa, topicStatus, topicLog;

// Fila simples: o callback MQTT só guarda; o loop() imprime (evita bloquear o MQTT)
struct Job { bool caixa; String json; };
Job fila[8]; uint8_t qIni = 0, qFim = 0;
bool qVazia() { return qIni == qFim; }
bool qPush(bool caixa, const String& j) { uint8_t n = (qFim + 1) % 8; if (n == qIni) return false; fila[qFim] = {caixa, j}; qFim = n; return true; }

// ---------- ESC/POS ----------
void raw(std::initializer_list<uint8_t> b) { for (uint8_t x : b) BT.write(x); }
void escInit()          { raw({0x1B, 0x40}); raw({0x1B, 0x74, CODEPAGE}); }
void align(uint8_t n)   { raw({0x1B, 0x61, n}); }          // 0 esq, 1 centro, 2 dir
void bold(bool on)      { raw({0x1B, 0x45, (uint8_t)on}); }
void size(uint8_t n)    { raw({0x1D, 0x21, n}); }          // 0x00 normal, 0x01 alto, 0x11 grande
void feedCut()          { raw({0x1B, 0x64, 4}); raw({0x1D, 0x56, 0x42, 0x00}); }

// UTF-8 -> CP850/858 (acentos do português)
uint8_t cp(uint32_t c) {
  switch (c) {
    case 0xE1: return 0xA0; case 0xE9: return 0x82; case 0xED: return 0xA1; case 0xF3: return 0xA2; case 0xFA: return 0xA3;
    case 0xE0: return 0x85; case 0xE2: return 0x83; case 0xEA: return 0x88; case 0xF4: return 0x93; case 0xE3: return 0xC6;
    case 0xF5: return 0xE4; case 0xE7: return 0x87; case 0xC1: return 0xB5; case 0xC9: return 0x90; case 0xCD: return 0xD6;
    case 0xD3: return 0xE0; case 0xDA: return 0xE9; case 0xC0: return 0xB7; case 0xC2: return 0xB6; case 0xCA: return 0xD2;
    case 0xD4: return 0xE2; case 0xC3: return 0xC7; case 0xD5: return 0xE5; case 0xC7: return 0x80; case 0xF1: return 0xA4;
    case 0xD1: return 0xA5; case 0xBA: return 0xA7; case 0xAA: return 0xA6; case 0xD7: return 'x'; case 0xB7: return '-';
    default: return c < 0x80 ? (uint8_t)c : '?';
  }
}
String cutUtf8(const String& s) { // caracteres (não bytes) -> vetor de code points como String CP850
  String o; o.reserve(s.length());
  for (size_t i = 0; i < s.length();) {
    uint8_t b = s[i]; uint32_t c; int n;
    if (b < 0x80) { c = b; n = 1; } else if ((b >> 5) == 6) { c = b & 0x1F; n = 2; } else if ((b >> 4) == 14) { c = b & 0x0F; n = 3; } else { c = '?'; n = 1; }
    for (int k = 1; k < n && i + k < s.length(); k++) c = (c << 6) | (s[i + k] & 0x3F);
    o += (char)cp(c); i += n;
  }
  return o;
}
void out(const String& s) { String t = cutUtf8(s); BT.write((const uint8_t*)t.c_str(), t.length()); }
void ln(const String& s = "") { out(s); BT.write(0x0A); }
void hr(char c = '-') { String s; for (uint8_t i = 0; i < LINE_W; i++) s += c; ln(s); }
void duas(const String& l, const String& r) {  // texto à esquerda + valor à direita
  String L = cutUtf8(l), R = cutUtf8(r);
  int sp = LINE_W - R.length() - L.length();
  if (sp < 1) { L = L.substring(0, max(0, (int)LINE_W - (int)R.length() - 1)); sp = 1; }
  String s = L; for (int i = 0; i < sp; i++) s += ' ';
  s += R; BT.write((const uint8_t*)s.c_str(), s.length()); BT.write(0x0A);
}
String brl(float v) { char b[16]; snprintf(b, sizeof b, "%.2f", v); String s(b); s.replace('.', ','); return "R$ " + s; }

void imprimeCozinha(JsonDocument& d) {
  escInit(); align(1); bold(true); size(0x11); ln("COZINHA"); size(0); ln(d["est"] | ""); bold(false); hr('=');
  align(0); bold(true); size(0x11); ln("MESA " + String(d["mesa"] | "?")); size(0x01); ln("Pedido #" + String((int)d["id"]));
  size(0); bold(false); ln(String(d["d"] | "") + " " + String(d["h"] | "") + "  Atend.: " + String(d["at"] | ""));
  ln("Cliente: " + String(d["cli"] | "")); hr();
  bold(true); size(0x01);
  for (JsonObject it : d["it"].as<JsonArray>()) ln(String((int)it["q"]) + "x " + String(it["n"] | ""));
  size(0); bold(false); hr();
  String obs = d["obs"] | "";
  if (obs.length()) { bold(true); ln("OBS: " + obs); bold(false); hr(); }
  feedCut();
}
void imprimeCaixa(JsonDocument& d) {
  escInit(); align(1); bold(true); size(0x11); ln(d["est"] | ""); size(0); ln("CONTA PARA CONFERENCIA"); bold(false); hr('=');
  align(0); bold(true); ln("MESA " + String(d["mesa"] | "?") + "  -  Pedido #" + String((int)d["id"])); bold(false);
  ln(String(d["d"] | "") + " " + String(d["h"] | "") + "  Atend.: " + String(d["at"] | ""));
  ln("Cliente: " + String(d["cli"] | "")); hr();
  for (JsonObject it : d["it"].as<JsonArray>()) {
    int q = it["q"]; float p = it["p"];
    ln(String(it["n"] | ""));
    duas("  " + String(q) + " x " + brl(p), brl(q * p));
  }
  hr(); bold(true); size(0x01); duas("TOTAL", brl((float)d["tot"])); size(0); bold(false); hr();
  String obs = d["obs"] | "";
  if (obs.length()) { ln("Obs: " + obs); hr(); }
  align(1); ln("Documento sem valor fiscal"); ln("Obrigado pela preferencia!");
  feedCut();
}

// ---------- Conexões ----------
bool btOk() { return BT.connected(); }
void btConecta() {
  static uint32_t ultimo = 0;
  if (btOk() || millis() - ultimo < 6000) return;
  ultimo = millis();
  Serial.printf("[bt] conectando em \"%s\"...\n", PRINTER_NAME);
  if (BT.connect(PRINTER_NAME)) Serial.println("[bt] impressora conectada");
  else Serial.println("[bt] falhou (ligada? pareada? nome correto?)");
}
void onMsg(char* topic, byte* p, unsigned int len) {
  String t(topic), j; j.reserve(len); for (unsigned i = 0; i < len; i++) j += (char)p[i];
  if (!qPush(t == topicCaixa, j)) mqtt.publish(topicLog.c_str(), "fila cheia: pedido descartado");
}
void mqttConecta() {
  if (mqtt.connected()) return;
  String cid = String("esp32-comanda-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  // sessão persistente (cleanSession=false): pedidos enviados enquanto o ESP32 estava off chegam ao religar
  if (mqtt.connect(cid.c_str(), nullptr, nullptr, topicStatus.c_str(), 1, true, "offline", false)) {
    mqtt.subscribe(topicCozinha.c_str(), 1); mqtt.subscribe(topicCaixa.c_str(), 1);
    mqtt.publish(topicStatus.c_str(), "online", true);
    Serial.println("[mqtt] conectado");
  } else delay(2000);
}

void setup() {
  Serial.begin(115200);
  topicCozinha = String(PREFIXO) + "/print/cozinha"; topicCaixa = String(PREFIXO) + "/print/caixa";
  topicStatus  = String(PREFIXO) + "/print/status";  topicLog   = String(PREFIXO) + "/print/log";
  BT.begin("ESP32-Comanda", true);                  // true = modo "master" (ele conecta na impressora)
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print('.'); }
  Serial.println("\n[wifi] " + WiFi.localIP().toString());
  mqtt.setServer(MQTT_HOST, MQTT_PORT); mqtt.setBufferSize(8192); mqtt.setCallback(onMsg); mqtt.setKeepAlive(30);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); delay(1000); return; }
  mqttConecta(); mqtt.loop();
  if (qVazia()) return;
  btConecta();
  if (!btOk()) return;                              // mantém na fila até a impressora voltar
  Job j = fila[qIni]; qIni = (qIni + 1) % 8;
  JsonDocument doc;
  if (deserializeJson(doc, j.json)) { mqtt.publish(topicLog.c_str(), "JSON invalido"); return; }
  if (j.caixa) imprimeCaixa(doc); else imprimeCozinha(doc);
  mqtt.publish(topicLog.c_str(), (String(j.caixa ? "caixa" : "cozinha") + " #" + String((int)doc["id"]) + " impresso").c_str());
}
