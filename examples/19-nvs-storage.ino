// Day 19: NVS 非易失存储 —— 掉电不丢数据
// 开机时读取计数,每次开机 +1,看掉电后是否保留
#include <Preferences.h>

Preferences prefs;

void setup() {
  Serial.begin(115200);
  delay(200);

  prefs.begin("codelab", false);  // namespace="codelab", readwrite

  int bootCount = prefs.getInt("bootCount", 0);  // 不存在则默认 0
  bootCount++;
  prefs.putInt("bootCount", bootCount);

  Serial.println("=== NVS 存储示例 ===");
  Serial.printf("这是第 %d 次开机\n", bootCount);
  Serial.printf("已存储的字符串: %s\n", prefs.getString("name", "(空)").c_str());

  // 第一次运行时写入名字
  if (bootCount == 1) {
    prefs.putString("name", "CodeLab 用户");
    Serial.println("已写入名字");
  }

  prefs.end();
}

void loop() {
  delay(5000);
  Serial.println("重启板卡试试,看计数会不会累加");
}
