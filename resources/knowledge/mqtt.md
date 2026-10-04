<!--
id: mqtt
keywords: mqtt,pubsubclient,发布,订阅,broker,emqx,mosquitto,topic,物联网消息,回调
-->
### MQTT 消息协议
MQTT 是轻量发布/订阅协议，设备连 Broker（如 EMQX、Mosquitto），按 Topic 收发，是 IoT 上云最常用方式。用 PubSubClient：
```cpp
#include <WiFi.h>
#include <PubSubClient.h>
WiFiClient net; PubSubClient mqtt(net);
void onMsg(char* topic, byte* payload, unsigned int len) {
  String msg; for (unsigned i=0;i<len;i++) msg += (char)payload[i];
  Serial.printf("[%s] %s\n", topic, msg.c_str());
  if (String(topic)=="lab/led") digitalWrite(2, msg=="on");
}
void connectMqtt() {
  while (!mqtt.connected()) {
    if (mqtt.connect("labcode-esp32")) { mqtt.subscribe("lab/led"); }
    else delay(2000);
  }
}
void setup() {
  Serial.begin(115200); pinMode(2,OUTPUT);
  WiFi.begin("ssid","pass"); while(WiFi.status()!=WL_CONNECTED) delay(300);
  mqtt.setServer("broker.emqx.io",1883); mqtt.setCallback(onMsg);
}
void loop() {
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();
  static unsigned long last=0;
  if (millis()-last>5000){ mqtt.publish("lab/temp","25.3"); last=millis(); }
}
```
要点：loop 里必须调 `mqtt.loop()` 并在断线时重连；`publish(topic,payload)` 发、`subscribe(topic)` 收，收到进回调；TLS 用 `WiFiClientSecure` + 8883 端口。
