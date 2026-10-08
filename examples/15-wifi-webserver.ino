// Day 15: Wi-Fi Web 服务器 —— 手机浏览器控制板载 LED
#include <WiFi.h>
#include <WebServer.h>

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-password";

#define LED_PIN 2
WebServer server(80);

void handleRoot() {
  String html = "<html><body style='font-size:24px;text-align:center;padding-top:40px'>";
  html += "<h2>CodeLab ESP32</h2>";
  html += "<p>LED 当前: " + String(digitalRead(LED_PIN) ? "亮" : "灭") + "</p>";
  html += "<p><a href='/on'><button style='font-size:20px;padding:10px 30px'>开灯</button></a></p>";
  html += "<p><a href='/off'><button style='font-size:20px;padding:10px 30px'>关灯</button></a></p>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

void handleOn() {
  digitalWrite(LED_PIN, HIGH);
  server.sendHeader("Location", "/");
  server.send(303);
}

void handleOff() {
  digitalWrite(LED_PIN, LOW);
  server.sendHeader("Location", "/");
  server.send(303);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  Serial.print("Web 服务器地址: http://");
  Serial.println(WiFi.localIP());

  server.on("/", handleRoot);
  server.on("/on", handleOn);
  server.on("/off", handleOff);
  server.begin();
}

void loop() {
  server.handleClient();
}
