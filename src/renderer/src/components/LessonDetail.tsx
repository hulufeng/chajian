import { useState } from 'react'

interface Lesson {
  id: number
  title: string
  topic: string
  example?: string
  objective: string[]
  hardware: string[]
  theory: string[]
  code?: string
  codeFile?: string
  expected: string[]
  practice: string[]
}

const LESSONS: Lesson[] = [
  {
    id: 1, title: '认识 ESP32 和开发板', topic: '入门',
    objective: ['了解 ESP32 芯片里有什么', '认识开发板各部分名称', '知道本软件能做什么'],
    hardware: ['ESP32-DevKitC 开发板一块', 'USB 数据线一根（必须是数据线）'],
    theory: [
      'ESP32 不是普通单片机，它把 CPU、内存、WiFi、蓝牙全部集成在一颗芯片里。你写的代码会编译成机器码，烧进芯片后自动运行。',
      '开发板上最关键的是：USB 口（供电+下载程序）、排针（外接电路）、BOOT 按钮（下载模式）、EN 按钮（复位）。',
      '本软件内置了编译器和仿真器，你不需要装 Arduino IDE。写完代码点编译，再点上传就能烧到板子上。',
    ],
    expected: ['能说出 ESP32 和 Arduino Uno 的区别', '能找到板子上的 USB 口和 BOOT 按钮'],
    practice: ['观察你手上的开发板，找到 USB 口、EN 按钮、BOOT 按钮', '用 USB 线连电脑，看设备管理器里是否出现 COM 口'],
  },
  {
    id: 2, title: '把开发环境跑起来', topic: '入门',
    objective: ['确认开发板能被软件识别', '学会编译和上传第一个程序'],
    hardware: ['ESP32 开发板已连接 USB'],
    theory: [
      '传统开发要装 Arduino IDE、加开发板包、装驱动，很容易卡环境。本软件已经内置 arduino-cli，你只需要选对串口。',
      '上传时如果失败，按住 BOOT 按钮不放，点上传，看到 "Connecting..." 后松开。这是 ESP32 的下载模式。',
    ],
    expected: ['串口面板能看到 COMx 端口', '上传成功后底部输出窗口显示 "Done uploading"'],
    practice: ['在右侧设备面板选择你的串口', '点上传按钮烧录下一课的 Blink 程序'],
  },
  {
    id: 3, title: '让板载 LED 闪起来', topic: 'GPIO', example: '01-blink.ino',
    objective: ['理解 setup() 和 loop() 的作用', '学会 pinMode 和 digitalWrite', '看到第一个灯闪烁'],
    hardware: ['ESP32 开发板（板载 LED 已接好，无需额外接线）'],
    theory: [
      '每块 ESP32 开发板上都有一个小 LED，连着 GPIO2。我们从它开始。',
      'setup() 开机只跑一次，用来初始化引脚。loop() 在 setup 之后反复执行，永远不停。',
      'digitalWrite(pin, HIGH) 输出 3.3V 高电平，LED 亮；LOW 输出 0V，LED 灭。',
    ],
    code: `#define LED_PIN 2

void setup() {
  pinMode(LED_PIN, OUTPUT);   // GPIO2 设为输出
  Serial.begin(115200);       // 串口 115200
}

void loop() {
  digitalWrite(LED_PIN, HIGH);  // 灯亮
  Serial.println("LED ON");
  delay(1000);                 // 等 1 秒
  digitalWrite(LED_PIN, LOW);   // 灯灭
  Serial.println("LED OFF");
  delay(1000);
}`,
    codeFile: '01-blink.ino',
    expected: ['板载 LED 每秒亮灭一次', '串口监视器输出 "LED ON" / "LED OFF"'],
    practice: ['把 delay(1000) 改成 delay(200)，看灯闪多快', '改成只亮 100ms、灭 2 秒，看效果'],
  },
  {
    id: 4, title: '串口日志调试', topic: '调试', example: '02-serial.ino',
    objective: ['学会用 Serial.println 打印信息', '查看芯片基本信息', '理解波特率'],
    hardware: ['USB 连接电脑即可'],
    theory: [
      '串口是最基本的调试手段。程序跑在芯片里你看不到，Serial.println 就是让它往电脑上打字。',
      '波特率 115200 表示每秒传 115200 位。芯片和电脑必须用一样的波特率，否则打印出来是乱码。',
      'ESP.getFreeHeap() 能看剩余内存，millis() 能看开机到现在过了多少毫秒。',
    ],
    code: `void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("===== 串口调试 =====");
  Serial.printf("CPU 频率: %d MHz\\n", getCpuFrequencyMhz());
  Serial.printf("剩余内存: %d bytes\\n", ESP.getFreeHeap());
}

void loop() {
  static int count = 0;
  Serial.printf("心跳 #%d, 已运行 %lu 秒\\n",
                count++, millis() / 1000);
  delay(2000);
}`,
    codeFile: '02-serial.ino',
    expected: ['串口每 2 秒打印一行心跳', '能看到 CPU 频率 240MHz'],
    practice: ['加一行 Serial.printf 打印芯片温度（如果支持）', '把 delay 改成 500，看打印频率'],
  },
  {
    id: 5, title: '控制外接 LED', topic: 'GPIO', example: '03-gpio-output.ino',
    objective: ['学会接外部 LED', '理解限流电阻的作用'],
    hardware: ['LED 一个', '220Ω 电阻一个（色环红红棕金）', '杜邦线两根'],
    theory: [
      '板载灯只有一个，我们接一个外部 LED 到 GPIO5。',
      '接线：LED 长腿（正极）→ 220Ω 电阻 → GPIO5；LED 短腿（负极）→ GND。',
      '为什么要电阻？ESP32 引脚直接输出 3.3V，LED 内阻很小，不串电阻会过流烧毁引脚。220Ω 是安全值。',
    ],
    code: `#define LED_PIN 5

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);  // 灯亮
  delay(1000);
  digitalWrite(LED_PIN, LOW);   // 灯灭
  delay(1000);
}`,
    codeFile: '03-gpio-output.ino',
    expected: ['外接 LED 每秒闪烁', '串口无输出（本程序不需要串口）'],
    practice: ['接第二个 LED 到 GPIO4，做两个灯交替闪', '把引脚号换成 GPIO2（板载灯），看效果'],
  },
  {
    id: 6, title: '读按键：GPIO 输入', topic: 'GPIO', example: '04-gpio-input.ino',
    objective: ['学会读取按键状态', '理解内部上拉电阻'],
    hardware: ['轻触按键一个', '杜邦线两根'],
    theory: [
      '按键一端接 GPIO4，另一端接 GND。不用外接电阻——用芯片内部上拉。',
      'INPUT_PULLUP 让引脚默认保持高电平（HIGH）。按下按键时接通 GND，读到 LOW。',
      '所以逻辑是反的：松开 = HIGH，按下 = LOW。写代码时别搞反。',
    ],
    code: `#define BTN_PIN 4
#define LED_PIN 2

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  if (digitalRead(BTN_PIN) == LOW) {
    digitalWrite(LED_PIN, HIGH);  // 按下亮灯
    Serial.println("按键按下");
  } else {
    digitalWrite(LED_PIN, LOW);
  }
  delay(50);
}`,
    codeFile: '04-gpio-input.ino',
    expected: ['按下按键 LED 亮，松开灭', '串口打印 "按键按下"'],
    practice: ['改成按一下切换 LED 状态（按一次亮，再按一次灭）'],
  },
  {
    id: 7, title: '按键消抖', topic: 'GPIO', example: '05-button-debounce.ino',
    objective: ['理解机械按键抖动现象', '学会软件消抖'],
    hardware: ['同第6课'],
    theory: [
      '机械按键的金属片接触时会快速弹跳，产生一串毛刺。芯片反应太快，按一下可能被识别成十次。',
      '解决办法：检测到电平变化后，等 20ms 再确认。这期间的跳变都忽略。',
      '如果不做计数器/菜单切换，只是简单亮灭灯，不消抖也行（多闪一下无所谓）。',
    ],
    code: `#define BTN_PIN 4
#define LED_PIN 2

int lastState = HIGH;
int currentState;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  int reading = digitalRead(BTN_PIN);
  if (reading != lastState) lastDebounceTime = millis();
  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading != currentState) {
      currentState = reading;
      if (currentState == LOW) {
        Serial.println("按键按下");
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
      }
    }
  }
  lastState = reading;
}`,
    codeFile: '05-button-debounce.ino',
    expected: ['按一次 LED 切换一次状态', '按多次不会误触发'],
    practice: ['把消抖时间改成 5ms，按快了试试会不会误触发'],
  },
  {
    id: 8, title: '外部中断', topic: 'GPIO', example: '06-interrupt.ino',
    objective: ['理解中断和轮询的区别', '学会 attachInterrupt'],
    hardware: ['同第6课'],
    theory: [
      '轮询：loop 里不停读按键——"按了吗？按了吗？" 浪费 CPU。',
      '中断：你干别的事，按键按下时芯片自动跳到中断函数执行。',
      '中断函数规矩：要短！不能 delay()，不能打印串口太多次，变量要加 volatile。',
    ],
    code: `#define BTN_PIN 4
#define LED_PIN 2
volatile bool buttonPressed = false;

void IRAM_ATTR onButton() {
  buttonPressed = true;  // 中断里只设标志
}

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(BTN_PIN), onButton, FALLING);
  Serial.begin(115200);
}

void loop() {
  if (buttonPressed) {
    buttonPressed = false;
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    Serial.println("中断触发!");
    delay(50);
  }
}`,
    codeFile: '06-interrupt.ino',
    expected: ['按按键 LED 切换，串口打印中断触发时间'],
    practice: ['在 loop 里加一个 1 秒一次的打印，看中断是否打断它'],
  },
  {
    id: 9, title: '硬件定时器', topic: '定时器', example: '07-timer.ino',
    objective: ['理解 delay() 的阻塞问题', '学会用硬件定时器'],
    hardware: ['无需额外接线'],
    theory: [
      'delay(1000) 会让 CPU 干等一秒，这一秒什么都不能做。同时要读按键、刷屏幕就碍事了。',
      '硬件定时器是芯片里独立的计时模块，到时间自动触发中断，不耽误主循环。',
      '比喻：delay 是坐在闹钟前盯着等它响；定时器是设好闹钟去干别的，响了自然叫你。',
    ],
    code: `#define LED_PIN 2
hw_timer_t *timer = NULL;
volatile bool ledState = false;

void IRAM_ATTR onTimer() {
  ledState = !ledState;
  digitalWrite(LED_PIN, ledState);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  timer = timerBegin(0, 80, true);      // 分频80 → 1MHz
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, 500000, true); // 500ms
  timerAlarmEnable(timer);
}

void loop() {
  delay(1000);
  Serial.printf("loop 还在跑: %lu ms\\n", millis());
}`,
    codeFile: '07-timer.ino',
    expected: ['LED 每 500ms 切换一次', 'loop 每秒打印一次，说明两者并行'],
    practice: ['改成每 100ms 切换一次，看 LED 呼吸效果'],
  },
  {
    id: 10, title: 'PWM 呼吸灯', topic: 'PWM', example: '08-pwm-breathe.ino',
    objective: ['理解 PWM 和占空比', '用 LEDC 库控制亮度'],
    hardware: ['LED 一个 + 220Ω 电阻'],
    theory: [
      'LED 不只是亮和灭。快速开关 LED，人眼会看到"半亮"——这就是 PWM。',
      '占空比 50% = 一半时间亮，看起来半亮；0% = 灭；100% = 最亮。',
      'ESP32 用 LEDC 外设做 PWM，8 个通道，频率和分辨率可配。',
    ],
    code: `#define LED_PIN 5
#define CHANNEL 0
#define FREQ 5000
#define RES 10  // 0~1023

void setup() {
  ledcSetup(CHANNEL, FREQ, RES);
  ledcAttachPin(LED_PIN, CHANNEL);
}

void loop() {
  for (int d = 0; d <= 1023; d += 5) {
    ledcWrite(CHANNEL, d);
    delay(5);
  }
  for (int d = 1023; d >= 0; d -= 5) {
    ledcWrite(CHANNEL, d);
    delay(5);
  }
}`,
    codeFile: '08-pwm-breathe.ino',
    expected: ['LED 渐亮渐暗，像呼吸一样'],
    practice: ['改成只渐亮不灭（做心跳灯效果）'],
  },
  {
    id: 11, title: 'ADC 读电位器', topic: 'ADC', example: '09-adc.ino',
    objective: ['理解模数转换', '读电位器阻值'],
    hardware: ['电位器（旋转编码器）一个', '杜邦线三根'],
    theory: [
      'GPIO 只能判断高/低电平。ADC 引脚能读出具体电压值。',
      'ESP32 的 ADC 是 12 位精度：0 到 4095 对应 0 到 3.3V。',
      '电位器中间脚接 GPIO34，两边脚分别接 3.3V 和 GND。旋转时中间脚电压在 0~3.3V 间变化。',
    ],
    code: `#define POT_PIN 34

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
}

void loop() {
  int raw = analogRead(POT_PIN);
  float volt = raw * 3.3 / 4095.0;
  Serial.printf("ADC=%4d  电压=%.2fV  旋钮=%d%%\\n",
                raw, volt, raw * 100 / 4095);
  delay(200);
}`,
    codeFile: '09-adc.ino',
    expected: ['旋转电位器，串口数值从 0 变到 4095'],
    practice: ['根据 ADC 值控制 LED 亮度（PWM）'],
  },
  {
    id: 12, title: 'I2C 总线扫描', topic: '通信', example: '10-i2c-scan.ino',
    objective: ['理解 I2C 协议', '扫描总线上的设备地址'],
    hardware: ['I2C 设备（OLED/SHT30 等）', '杜邦线四根'],
    theory: [
      '每个传感器接两根线就要占两个 GPIO，接 5 个就不够了。I2C 用 SDA+SCL 两根线接十几个设备。',
      '每个 I2C 设备有唯一地址。主机发数据时带地址，对应设备才回应。',
      'ESP32 默认 SDA=GPIO21，SCL=GPIO22。',
    ],
    code: `#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Serial.println("I2C 扫描开始...");
}

void loop() {
  byte count = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("发现设备: 0x%02X\\n", addr);
      count++;
    }
  }
  if (count == 0) Serial.println("未发现 I2C 设备");
  else Serial.printf("共 %d 个设备\\n", count);
  delay(5000);
}`,
    codeFile: '10-i2c-scan.ino',
    expected: ['如果接了 OLED，串口显示 0x3C', '没接设备显示 "未发现"'],
    practice: ['接一个 SHT30（地址 0x44），看扫描结果'],
  },
  {
    id: 13, title: '温湿度传感器 SHT30', topic: '通信',
    objective: ['读取 SHT30 温湿度数据', '安装和使用 Adafruit 传感器库'],
    hardware: ['SHT30 模块一个', '杜邦线四根（VIN/GND/SDA/SCL）'],
    theory: [
      'SHT30 是 Sensirion 出的高精度温湿度芯片，I2C 接口，默认地址 0x44。温度精度 ±0.3°C，湿度精度 ±2%。',
      '接线：VIN 接 3.3V，GND 接 GND，SDA 接 GPIO21，SCL 接 GPIO22（和第12课 I2C 扫描一样）。',
      '使用 Adafruit_SHT31 库。先在库管理器搜索安装 "Adafruit SHT31 Library"，它会自动装上 Adafruit BusIO 和 Unified Sensor 依赖。',
      '代码分三步：begin() 初始化 → readTemperature() 读温度 → readHumidity() 读湿度。注意读之前要等传感器测量完成（约 15ms）。',
    ],
    code: `#include <Wire.h>
#include <Adafruit_SHT31.h>

Adafruit_SHT31 sht30 = Adafruit_SHT31();

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!sht30.begin(0x44)) {
    Serial.println("SHT30 未找到！检查接线");
    while (1) delay(1000);
  }
  Serial.println("SHT30 初始化成功");
}

void loop() {
  float temp = sht30.readTemperature();
  float humi = sht30.readHumidity();
  Serial.printf("温度: %.1f°C  湿度: %.1f%%\\n", temp, humi);

  if (temp > 30.0) {
    Serial.println("⚠ 温度过高！");
  }
  delay(2000);
}`,
    expected: ['串口每 2 秒打印一行 "温度: 25.0°C  湿度: 55.0%"', '对着传感器哈气，湿度应明显上升'],
    practice: ['温度超过 30°C 时板载 LED 亮起报警', '改成 OLED 显示（结合第14课）'],
  },
  {
    id: 14, title: 'SPI 与 OLED 屏', topic: '通信',
    objective: ['在 SSD1306 OLED 上显示文字和图形', '理解 SPI 和 I2C 两种接法'],
    hardware: ['0.96寸 SSD1306 OLED（128x64）', '杜邦线4根（I2C版）或7根（SPI版）'],
    theory: [
      'SSD1306 是最常见的 OLED 驱动芯片，128x64 像素单色屏。买的时候分 I2C 和 SPI 两种版本，I2C 版只需要 4 根线更简单。',
      '用 Adafruit_SSD1306 + Adafruit_GFX 两个库。GFX 负责画点画线画字，SSD1306 负责把数据刷到屏上。',
      '显示流程：先 clearDisplay() 清屏 → setCursor(x,y) 设光标 → print() 写文字 → display() 刷新。不调 display() 屏幕不会变。',
      'I2C 版接线：VCC→3.3V，GND→GND，SDA→GPIO21，SCL→GPIO22。',
    ],
    code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_W 128
#define SCREEN_H 64
#define OLED_ADDR 0x3C
Adafruit_SSD1306 oled(SCREEN_W, SCREEN_H, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED 未找到");
    while (1) delay(1000);
  }
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
}

void loop() {
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.println("Hello ESP32!");
  oled.setTextSize(2);
  oled.setCursor(0, 20);
  oled.print("UP: ");
  oled.print(millis() / 1000);
  oled.print("s");
  oled.setTextSize(1);
  oled.setCursor(0, 50);
  oled.println("www.codelab.dev");
  oled.display();
  delay(1000);
}`,
    expected: ['OLED 第一行显示 Hello ESP32', '第二行大字显示开机秒数（每秒+1）', '第三行显示网址'],
    practice: ['把 SHT30 温湿度读到 OLED 上', '画一个进度条'],
  },
  {
    id: 15, title: '连接 WiFi', topic: '网络',
    objective: ['让 ESP32 连接 2.4GHz WiFi', '获取并打印 IP 地址', '处理连接失败的情况'],
    hardware: ['2.4GHz WiFi 网络（注意不支持5GHz）', '知道 WiFi 名称和密码'],
    theory: [
      'ESP32 内置 WiFi 模块，这是它和普通 Arduino Uno 最大的区别。注意只支持 2.4GHz，5GHz 路由器需要开 2.4G 频段。',
      'WiFi.begin() 开始连接后不会立即成功，需要循环等待 WiFi.status() 返回 WL_CONNECTED。',
      '常见状态码：WL_IDLE_STATUS(0) 正在连接，WL_NO_SSID_AVAIL(1) 找不到WiFi名，WL_CONNECTED(3) 成功，WL_DISCONNECTED(6) 断开。',
      '连上后 WiFi.localIP() 返回分配到的 IP 地址，后面网页服务器和 MQTT 都要用。',
    ],
    code: `#include <WiFi.h>

const char* WIFI_SSID = "你的WiFi名称";
const char* WIFI_PASS = "你的WiFi密码";

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.print("连接到 ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    Serial.print(".");
    delay(500);
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("连接成功！IP 地址: ");
    Serial.println(WiFi.localIP());
    Serial.print("信号强度: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println();
    Serial.println("连接失败！检查WiFi名和密码");
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi 断开，重连中...");
    WiFi.reconnect();
  }
  delay(5000);
}`,
    expected: ['串口打印连接过程和最终 IP 地址', '电脑 ping 这个 IP 能通', '信号强度 RSSI 一般在 -40 到 -80 dBm'],
    practice: ['把 WiFi 名和密码改成你自己的，烧录试试', '故意输错密码，看连接失败提示', '路由器断电后看重连逻辑'],
  },
  {
    id: 16, title: '发 HTTP 请求', topic: '网络',
    objective: ['用 HTTPClient 发 GET 请求获取网络数据', '理解 HTTP 状态码'],
    hardware: ['已连接 WiFi'],
    theory: [
      'HTTP 是网页和 API 的通用协议。ESP32 可以像浏览器一样向服务器请求数据。',
      'GET 请求：从服务器获取数据（比如查天气）。POST 请求：向服务器提交数据（比如上报传感器值）。',
      'HTTPClient 的用法：begin(url) → GET() 发请求 → 检查返回码 → getString() 拿内容 → end() 清理。',
      '状态码：200=成功，404=页面不存在，403=没权限，500=服务器错误。先判断 code 再读 body。',
    ],
    code: `#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.println("WiFi 已连接");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin("http://httpbin.org/get");
    int code = http.GET();
    Serial.printf("HTTP 返回码: %d\\n", code);
    if (code > 0) {
      String payload = http.getString();
      Serial.println("返回内容:");
      Serial.println(payload);
    } else {
      Serial.printf("请求失败: %s\\n", http.errorToString(code).c_str());
    }
    http.end();
  }
  delay(10000);
}`,
    expected: ['串口每 10 秒打印一次 httpbin.org 返回的 JSON', '返回码应该是 200'],
    practice: ['改成 POST 请求，把传感器数据发给服务器', '访问一个天气 API 获取实时天气'],
  },
  {
    id: 17, title: '解析 JSON 数据', topic: '数据',
    objective: ['用 ArduinoJson 库解析嵌套 JSON', '理解 JSON 数据结构'],
    hardware: ['已连接 WiFi'],
    theory: [
      '服务器返回的数据通常是 JSON 格式，比如：{"city":"菏泽","temp":26.5,"humidity":60}。',
      '不要自己写字符串分割——JSON 有嵌套、数组、转义字符，手动解析极易出错。用 ArduinoJson 库。',
      'ArduinoJson 7.x 用法：创建 JsonDocument → deserializeJson() 解析 → 用 doc["key"] 取值。',
      '注意 ESP32 内存有限，JsonDocument 大小要匹配 JSON 长度。太小会截断，太大会浪费内存。',
    ],
    code: `#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin("http://httpbin.org/json");
    int code = http.GET();
    if (code == 200) {
      String body = http.getString();
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, body);
      if (!err) {
        // 解析嵌套 JSON：{"slideshow":{"title":"Sample Slide Show"}}
        const char* title = doc["slideshow"]["title"];
        int slideCount = doc["slideshow"]["slides"].size();
        Serial.printf("标题: %s, 幻灯片数: %d\\n", title, slideCount);
      }
    }
    http.end();
  }
  delay(10000);
}`,
    expected: ['串口打印解析出的标题和幻灯片数量', '不报错就是解析成功'],
    practice: ['解析一个天气 API 的返回，提取温度和城市名', '数组遍历：for 循环读取 JSON 数组里每个元素'],
  },
  {
    id: 18, title: 'NTP 网络时间', topic: '网络',
    objective: ['从 NTP 服务器自动同步时间', '格式化打印日期时间'],
    hardware: ['已连接 WiFi'],
    theory: [
      'ESP32 板子上没有纽扣电池，断电后时间就归零。连上 WiFi 后可以从 NTP 服务器自动校准。',
      'configTime() 三个参数：时区字符串、NTP 服务器地址、备用 NTP 服务器。"GMT-8" 是东八区北京时间。',
      'getLocalTime() 把时间写入 tm 结构体，里面有 tm_hour（时）、tm_min（分）、tm_mday（日）等字段。',
    ],
    code: `#include <WiFi.h>
#include "time.h"

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 8 * 3600;  // 东八区
const int   daylightOffset_sec = 0;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
}

void loop() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    Serial.printf("%04d-%02d-%02d %02d:%02d:%02d\\n",
      timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
      timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  } else {
    Serial.println("时间未同步");
  }
  delay(1000);
}`,
    expected: ['串口每秒打印当前时间，格式 YYYY-MM-DD HH:MM:SS', '时间应该和你手机一致'],
    practice: ['做一个 OLED 电子钟', '每天 8:00 自动发一条 MQTT 消息'],
  },
  {
    id: 19, title: 'MQTT 物联网通信', topic: '网络',
    objective: ['连接公共 MQTT Broker', '发布和订阅消息'],
    hardware: ['已连接 WiFi', '手机装一个 MQTT 客户端 App（如 MQTTX）'],
    theory: [
      'MQTT 是物联网最常用的通信协议。采用发布/订阅模式：ESP32 把数据发到某个"主题"，手机订阅同一个主题就能收到。',
      '公共测试 Broker：broker.emqx.io，端口 1883，不需要用户名密码。正式项目用自己的服务器。',
      '主题（Topic）像聊天房间号，比如 "codelab/sensor/temp"。发布和订阅必须用完全相同的主题才能通信。',
      '用 PubSubClient 库。需要设置服务器地址和端口，连接后 loop 里必须调用 client.loop() 保持心跳。',
    ],
    code: `#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";
const char* MQTT_SERVER = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;

WiFiClient espClient;
PubSubClient client(espClient);

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.printf("收到 [%s]: ", topic);
  for (unsigned int i = 0; i < length; i++) Serial.print((char)payload[i]);
  Serial.println();
  // 收到 "led/control" 主题的消息，控制 LED
  if (strcmp(topic, "codelab/led") == 0) {
    if (payload[0] == '1') digitalWrite(2, HIGH);
    else digitalWrite(2, LOW);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setCallback(callback);
  client.connect("esp32-client-001");
  client.subscribe("codelab/led");
}

void loop() {
  client.loop();
  static int count = 0;
  if (millis() % 5000 < 100) {
    char msg[20];
    snprintf(msg, 20, "count=%d", count++);
    client.publish("codelab/hello", msg);
  }
  delay(10);
}`,
    expected: ['手机 MQTTX 订阅 codelab/hello 能看到计数消息', '手机发布 codelab/led 消息内容 "1" 或 "0" 控制板载灯'],
    practice: ['换一个你自己的主题名（加你的ID），避免和别人冲突', '订阅主题收到指令后控制 PWM 亮度'],
  },
  {
    id: 20, title: '温湿度上报到手机', topic: '网络',
    objective: ['整合 SHT30 + WiFi + MQTT 三个模块', '做完整数据上报链路'],
    hardware: ['SHT30 温湿度传感器', '已连接 WiFi'],
    theory: [
      '这是第一个完整物联网项目：传感器采集 → WiFi 联网 → MQTT 上报 → 手机查看。',
      '代码结构：setup 里初始化所有模块，loop 里读传感器 → 发布 MQTT → 延时等待。',
      '关键：WiFi 和 MQTT 都可能断开，每次循环要检查连接状态，断了自动重连。',
    ],
    code: `#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";
WiFiClient net;
PubSubClient mqtt(net);
Adafruit_SHT31 sht;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  sht.begin(0x44);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer("broker.emqx.io", 1883);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  if (!mqtt.connected()) mqtt.connect("esp32-sensor-001");
  mqtt.loop();

  float t = sht.readTemperature();
  float h = sht.readHumidity();
  char buf[32];
  snprintf(buf, 32, "%.1f,%.1f", t, h);
  mqtt.publish("codelab/env/temphumi", buf);
  Serial.printf("上报: %s\\n", buf);
  delay(10000);  // 每10秒上报一次
}`,
    expected: ['手机 MQTT App 订阅 codelab/env/temphumi，每 10 秒收到一条温湿度数据', '格式：温度,湿度，如 "26.5,55.0"'],
    practice: ['温度超过 30°C 时额外发一条告警消息', '在手机上做一个简单的数据曲线'],
  },
  {
    id: 21, title: 'WiFi 配网（AP 模式）', topic: '网络',
    objective: ['实现设备不写死 WiFi 密码也能联网', '理解 AP+WebServer 配网流程'],
    hardware: ['ESP32 开发板'],
    theory: [
      '产品卖给用户时不可能在代码里写死 WiFi 密码。需要让用户通过手机配置。',
      '配网流程：ESP32 开机后先开一个热点（如 "ESP32-Setup"）→ 手机连这个热点 → 手机浏览器打开 192.168.4.1 → 网页输入家里 WiFi → ESP32 保存并重连。',
      'WiFi 信息存在 NVS（非易失存储）里，用 Preferences 库读写，断电不丢。',
    ],
    code: `#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>

WebServer server(80);
Preferences prefs;
String savedSSID, savedPASS;

void handleRoot() {
  String html = "<h2>WiFi 配网</h2><form method=POST action=/save>";
  html += "WiFi名: <input name=ssid><br>";
  html += "密码: <input name=pass type=password><br>";
  html += "<input type=submit value=连接></form>";
  server.send(200, "text/html", html);
}

void handleSave() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  prefs.begin("wifi", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  server.send(200, "text/html", "已保存，重启连接中...");
  delay(2000);
  ESP.restart();
}

void setup() {
  Serial.begin(115200);
  prefs.begin("wifi", true);
  savedSSID = prefs.getString("ssid", "");
  savedPASS = prefs.getString("pass", "");
  prefs.end();

  if (savedSSID.length() > 0) {
    WiFi.begin(savedSSID.c_str(), savedPASS.c_str());
    if (WiFi.waitForConnectResult(10000) == WL_CONNECTED) {
      Serial.println("已连WiFi: " + WiFi.localIP().toString());
      return;  // 连上了，正常运行
    }
  }
  // 没存WiFi或连不上，开配网热点
  WiFi.softAP("ESP32-Setup", "12345678");
  Serial.printf("配网热点已开: %s\n", WiFi.softAPIP().toString().c_str());
  server.on("/", handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.begin();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    // 正常业务逻辑
  } else {
    server.handleClient();  // 配网模式
  }
}`,
    expected: ['首次开机手机能搜到 ESP32-Setup 热点', '连热点后浏览器打开 192.168.4.1 能看到配网页面', '输入 WiFi 后设备重启自动连接'],
    practice: ['加一个"清除配网"按钮', '加 LED 指示配网状态（快闪=配网，慢闪=已连接）'],
  },
  {
    id: 22, title: 'ESP32 网页服务器', topic: '网络',
    objective: ['在 ESP32 上跑 Web 服务器', '手机浏览器控制 LED'],
    hardware: ['LED + 220Ω 电阻（或用板载灯）', '已连接 WiFi'],
    theory: [
      'ESP32 可以跑一个微型网页服务器。手机和 ESP32 在同一 WiFi 下，浏览器输入 ESP32 的 IP 就能访问。',
      'WebServer 库用法：server.on("/路径", 处理函数) → server.begin() → loop 里 server.handleClient()。',
      '返回 HTML 就是一个网页。访问 /on 执行开灯，访问 /off 执行关灯。',
      'ESP32 同时只能处理少量连接，不适合做高并发网站，但控制小设备足够。',
    ],
    code: `#include <WiFi.h>
#include <WebServer.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";
WebServer server(80);
bool ledState = false;

void handleRoot() {
  String html = "<html><meta name=viewport content='width=device-width'>";
  html += "<head><style>body{font-family:sans-serif;text-align:center;margin-top:50px}";
  html += ".btn{font-size:24px;padding:15px 40px;margin:10px;border:none;border-radius:10px}</style></head>";
  html += "<h1>ESP32 控制</h1><p>LED: " + String(ledState?"ON":"OFF") + "</p>";
  html += "<a href=/on><button class=btn style=background:#a6e3a1>开灯</button></a>";
  html += "<a href=/off><button class=btn style=background:#f38ba8>关灯</button></a>";
  html += "</html>";
  server.send(200, "text/html", html);
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.on("/on", [](){ ledState=true; digitalWrite(2,HIGH); server.sendHeader("Location","/"); server.send(302); });
  server.on("/off", [](){ ledState=false; digitalWrite(2,LOW); server.sendHeader("Location","/"); server.send(302); });
  server.begin();
}

void loop() {
  server.handleClient();
}`,
    expected: ['手机浏览器访问 ESP32 IP，看到控制页面', '点"开灯"按钮板载灯亮，点"关灯"灭', '页面自适应手机屏幕'],
    practice: ['加一个滑块控制 PWM 亮度', '网页上显示当前时间或传感器数据'],
  },
  {
    id: 23, title: '蓝牙 BLE 通信', topic: '无线',
    objective: ['用 BLE 和手机通信', '理解 Service/Characteristic 概念'],
    hardware: ['手机（装 nRF Connect 或 LightBlue App）'],
    theory: [
      'BLE（低功耗蓝牙）适合电池供电的小设备，不需要路由器，手机直接连。',
      '两个核心概念：Service（服务，像一个功能模块）和 Characteristic（特征值，像模块里的一个变量）。手机读写 Characteristic 就能和 ESP32 通信。',
      '用 NimBLE-Arduino 库比默认 BLE 库省内存。创建一个 Service，加一个可写的 Characteristic，手机连上来后往里面写数据。',
    ],
    code: `#include <NimBLEDevice.h>

BLEServer* pServer;
bool ledOn = false;

class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    if (value.length() > 0) {
      char cmd = value[0];
      if (cmd == '1') { digitalWrite(2, HIGH); ledOn = true; }
      if (cmd == '0') { digitalWrite(2, LOW); ledOn = false; }
      Serial.printf("收到: %c\\n", cmd);
    }
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  BLEDevice::init("ESP32-Lamp");
  pServer = BLEDevice::createServer();
  BLEService* pService = pServer->createService("00FF");
  BLECharacteristic* pChar = pService->createCharacteristic(
    "FF01", NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ);
  pChar->setCallbacks(new MyCallbacks());
  pService->start();
  BLEAdvertising* pAdv = BLEDevice::getAdvertising();
  pAdv->addServiceUUID("00FF");
  pAdv->start();
  Serial.println("BLE 已广播: ESP32-Lamp");
}

void loop() { delay(1000); }`,
    expected: ['手机 nRF Connect 能扫到 "ESP32-Lamp"', '连接后找到 00FF 服务和 FF01 特征值', '往特征值写 "1" 开灯，写 "0" 关灯'],
    practice: ['加一个通知（Notify）特征值，ESP32 主动推送状态', '做一个亮度控制：写 0-255 调 PWM'],
  },
  {
    id: 24, title: '深度睡眠省电', topic: '低功耗',
    objective: ['用 Deep-sleep 降低功耗', '实现定时唤醒'],
    hardware: ['电池供电的 ESP32 开发板'],
    theory: [
      '正常开机电流约 100mA，Deep-sleep 模式只有 10μA 左右，差 10000 倍。电池供电设备必须用。',
      '工作方式：大部分时间睡觉，每隔一段时间醒来读一次传感器、上报数据，然后继续睡。',
      '定时器唤醒：esp_sleep_enable_timer_wakeup(微秒)。外部唤醒：按按钮触发。',
      '注意：Deep-sleep 后内存丢失，变量归零，相当于重启 setup()。要保留的数据存在 RTC 内存或 NVS 里。',
    ],
    code: `#define uS_TO_S_FACTOR 1000000ULL
#define TIME_TO_SLEEP  30  // 睡30秒

RTC_DATA_ATTR int bootCount = 0;  // RTC内存，睡眠不丢失

void setup() {
  Serial.begin(115200);
  bootCount++;
  Serial.printf("第%d次启动\\n", bootCount);

  // 这里放传感器读取和上报逻辑
  float temp = 25.0;  // 实际读SHT30
  Serial.printf("温度: %.1f°C\\n", temp);
  // TODO: 上报到MQTT

  // 准备睡觉
  esp_sleep_enable_timer_wakeup(TIME_TO_SLEEP * uS_TO_S_FACTOR);
  Serial.printf("进入深度睡眠，%d秒后唤醒\\n", TIME_TO_SLEEP);
  esp_deep_sleep_start();
}

void loop() {
  // 不会执行到这里，setup跑完就睡了
}`,
    expected: ['每 30 秒醒来一次，串口打印启动次数和温度', '用电流表测睡眠电流应在 0.1mA 以下'],
    practice: ['加一个按钮，按下立即唤醒（EXT0 唤醒）', '改成每 5 分钟上报一次数据'],
  },
  {
    id: 25, title: 'OTA 无线升级', topic: '进阶',
    objective: ['通过 WiFi 上传新固件，不插 USB'],
    hardware: ['已连接 WiFi（电脑和ESP32同一网络）'],
    theory: [
      '产品装在墙上/柜子里，不可能每次改代码都拆机插 USB。OTA（Over The Air）通过 WiFi 上传新固件。',
      '第一次需要 USB 上传带 OTA 的代码。以后 Arduino IDE 的端口列表里会出现一个网络端口，选它就能无线上传。',
      '代码很简单：引入 ArduinoOTA 库，setup 里 begin()，loop 里 handle()。',
    ],
    code: `#include <WiFi.h>
#include <ArduinoOTA.h>

const char* WIFI_SSID = "你的WiFi";
const char* WIFI_PASS = "密码";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  ArduinoOTA.onStart([](){ Serial.println("开始OTA"); });
  ArduinoOTA.onEnd([](){ Serial.println("\\n完成"); });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total){
    Serial.printf("OTA: %d%%\\r", progress*100/total);
  });
  ArduinoOTA.onError([](ota_error_t e){ Serial.printf("OTA错误:%d\\n", e); });

  ArduinoOTA.begin();
  Serial.print("OTA 就绪, IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  ArduinoOTA.handle();
}`,
    expected: ['Arduino IDE 端口列表出现网络端口（含 esp32.local）', '选网络端口上传，无线烧录成功'],
    practice: ['改 LED 闪烁频率，无线上传看效果', '加 OTA 密码验证'],
  },
  {
    id: 26, title: '项目：环境监测站（上）', topic: '项目',
    objective: ['整合 I2C + OLED + SHT30', '做出本地数据显示终端'],
    hardware: ['SHT30 温湿度传感器', '0.96寸 OLED 屏', '杜邦线若干'],
    theory: [
      '把第13课（SHT30）和第14课（OLED）合起来：读温湿度 → 显示到屏幕上。',
      '接线：SDA→21，SCL→22，VIN→3.3V，GND→GND。两个 I2C 设备并联在同一组 SDA/SCL 上，靠地址区分。',
      '代码结构：setup 初始化 I2C、OLED、SHT30；loop 读传感器 → 清屏 → 写文字 → display 刷新。',
    ],
    code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_SHT31.h>

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_SHT31 sht;

void setup() {
  Wire.begin(21, 22);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  sht.begin(0x44);
  oled.clearDisplay();
}

void loop() {
  float t = sht.readTemperature();
  float h = sht.readHumidity();
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("=== 环境监测 ===");
  oled.setTextSize(2);
  oled.setCursor(0, 16);
  oled.print("T: "); oled.print(t, 1); oled.print("C");
  oled.setCursor(0, 40);
  oled.print("H: "); oled.print(h, 0); oled.print("%");
  oled.display();
  delay(2000);
}`,
    expected: ['OLED 第一行标题，下面大字显示温度和湿度', '数值每 2 秒更新一次'],
    practice: ['加一个图标（温度高显示警告）', '加光敏电阻显示光线'],
  },
  {
    id: 27, title: '项目：环境监测站（下）', topic: '项目',
    objective: ['在本地显示基础上加 WiFi + MQTT 上报', '处理断网重连'],
    hardware: ['同第26课'],
    theory: [
      '在昨天的本地监测站基础上，加 WiFi 连接和 MQTT 上报，手机远程看数据。',
      '关键问题：WiFi 会断、MQTT 会断。每次 loop 都要检查连接状态，断了自动重连，不能让程序卡死。',
    ],
    code: `#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_SHT31.h>

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_SHT31 sht;
WiFiClient net;
PubSubClient mqtt(net);

void setup() {
  Wire.begin(21, 22);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  sht.begin(0x44);
  WiFi.begin("你的WiFi", "密码");
  mqtt.setServer("broker.emqx.io", 1883);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  if (!mqtt.connected()) mqtt.connect("env-station-001");
  mqtt.loop();

  float t = sht.readTemperature();
  float h = sht.readHumidity();

  // OLED 显示
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.printf("T:%.1fC H:%.0f%%", t, h);
  oled.setCursor(0, 20);
  oled.print(WiFi.status()==WL_CONNECTED ? "WiFi:OK" : "WiFi:..");
  oled.display();

  // MQTT 上报
  char buf[32];
  snprintf(buf, 32, "%.1f,%.1f", t, h);
  mqtt.publish("codelab/station/env", buf);

  delay(5000);
}`,
    expected: ['OLED 同时显示数据和 WiFi 状态', '手机 MQTT App 每 5 秒收到一组数据'],
    practice: ['断网后看是否自动重连', '温度异常时发 MQTT 告警'],
  },
  {
    id: 28, title: '项目：蓝牙遥控灯', topic: '项目',
    objective: ['BLE 接收指令 + PWM 调光综合项目'],
    hardware: ['LED + 220Ω 电阻接 GPIO5', '手机装 BLE 调试 App'],
    theory: [
      'ESP32 开 BLE 广播，手机连接后发送指令。ESP32 解析指令，控制 PWM 输出改变 LED 亮度。',
      '指令协议：发 "on" 开灯，"off" 关灯，"pwm:128" 设亮度。用字符串解析。',
    ],
    code: `#include <NimBLEDevice.h>

BLECharacteristic* pChar;
int brightness = 128;

class Callbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) {
    String cmd = String(c->getValue().c_str());
    if (cmd == "on") ledcWrite(0, brightness);
    else if (cmd == "off") ledcWrite(0, 0);
    else if (cmd.startsWith("pwm:")) {
      brightness = cmd.substring(4).toInt();
      ledcWrite(0, brightness);
    }
  }
};

void setup() {
  ledcSetup(0, 5000, 10);
  ledcAttachPin(5, 0);
  BLEDevice::init("ESP32-Lamp");
  BLEServer* s = BLEDevice::createServer();
  BLEService* svc = s->createService("00FF");
  pChar = svc->createCharacteristic("FF01",
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ);
  pChar->setCallbacks(new Callbacks());
  svc->start();
  BLEDevice::getAdvertising()->start();
}

void loop() { delay(1000); }`,
    expected: ['手机 BLE App 发 "on" 开灯，"off" 关灯', '发 "pwm:256" 设亮度为 25%'],
    practice: ['加一个呼吸模式指令 "breathe"', '手机 App 做一个滑块'],
  },
  {
    id: 29, title: '项目：网页温控风扇', topic: '项目',
    objective: ['温度传感器 + 继电器 + 网页控制'],
    hardware: ['DS18B20 温度传感器', '继电器模块', '小风扇（USB安全）'],
    theory: [
      'DS18B20 是单总线数字温度传感器，一个引脚接多个传感器。继电器用来控制风扇电源。',
      '网页提供两个功能：手动模式（网页按钮开关风扇）和自动模式（温度超阈值自动开）。',
      '继电器控制强电时务必注意绝缘，不熟强电就用 USB 小风扇测试。',
    ],
    code: `#include <WiFi.h>
#include <WebServer.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#define FAN_PIN 2
OneWire oneWire(4);
DallasTemperature ds18b20(&oneWire);
WebServer server(80);
bool autoMode = true;

void handleRoot() {
  float t = ds18b20.getTempCByIndex(0);
  String html = "<h1>温控风扇</h1><p>温度: ";
  html += String(t, 1) + "°C</p>";
  html += "<p>模式: " + String(autoMode?"自动":"手动") + "</p>";
  html += "<a href=/fan/on>开</a> <a href=/fan/off>关</a> ";
  html += "<a href=/auto>自动</a>";
  server.send(200, "text/html", html);
}

void setup() {
  pinMode(FAN_PIN, OUTPUT);
  ds18b20.begin();
  WiFi.begin("WiFi", "密码");
  while (WiFi.status() != WL_CONNECTED) delay(500);
  server.on("/", handleRoot);
  server.on("/fan/on", [](){ digitalWrite(FAN_PIN,HIGH); server.sendHeader("Location","/"); server.send(302); });
  server.on("/fan/off", [](){ digitalWrite(FAN_PIN,LOW); server.sendHeader("Location","/"); server.send(302); });
  server.on("/auto", [](){ autoMode=true; server.sendHeader("Location","/"); server.send(302); });
  server.begin();
}

void loop() {
  server.handleClient();
  ds18b20.requestTemperatures();
  float t = ds18b20.getTempCByIndex(0);
  if (autoMode) {
    digitalWrite(FAN_PIN, t > 30.0 ? HIGH : LOW);
  }
}`,
    expected: ['网页显示当前温度', '手动模式可控制风扇开关', '自动模式温度超30°C自动开风扇'],
    practice: ['网页加温度阈值设置', '加温度历史记录'],
  },
  {
    id: 30, title: '毕业项目：完整物联网节点', topic: '项目',
    objective: ['综合运用所有技能', '做出可展示的完整作品'],
    hardware: ['SHT30 + OLED 屏', 'LED 或继电器', 'WiFi 环境'],
    theory: [
      '毕业项目要求把前面学的全部串起来：',
      '1. SHT30 采集温湿度 → 2. OLED 本地显示 → 3. WiFi 联网 → 4. MQTT 上报云端 → 5. 手机远程控制继电器 → 6. Deep-sleep 定时唤醒省电。',
      '你已经学会了：GPIO 输入输出、PWM、中断、I2C/SPI 通信、WiFi、HTTP、MQTT、Web 服务器、BLE、低功耗。这些是嵌入式物联网开发的完整基本功。',
      '下一步：选一个你生活中的真实需求，用这些技能做出来。比如智能花盆、门锁提醒、老人呼叫器。',
    ],
    expected: ['一个能跑、能联网、能手机控制、省电的完整作品'],
    practice: ['想一个自己的项目，从需求分析开始做', '把代码整理好，写一份 README'],
  },
]

// ── 渲染辅助 ──
function CodeBlock({ code }: { code: string }) {
  return (
    <pre style={{
      background: '#11111b', border: '1px solid #313244', borderRadius: 8,
      padding: '14px 16px', overflow: 'auto', margin: '12px 0',
      fontSize: 13, lineHeight: 1.6, color: '#cdd6f4',
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    }}>
      {code.split('\n').map((line, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span style={{ color: '#45475a', marginRight: 16, minWidth: 24, textAlign: 'right', userSelect: 'none' }}>{i + 1}</span>
          <span style={{ whiteSpace: 'pre' }}>{line}</span>
        </div>
      ))}
    </pre>
  )
}

function Section({ title, children, color }: { title: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{
        fontSize: 15, fontWeight: 600, margin: '0 0 10px 0',
        color: color || '#89b4fa', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ width: 4, height: 16, background: color || '#89b4fa', borderRadius: 2 }} />
        {title}
      </h3>
      {children}
    </div>
  )
}

interface LessonDetailProps {
  lessonId: number
  onBack: () => void
  onOpenExample: (fileName: string) => void
  onOpenSimulator: (fileName: string) => void
  onToggleDone: (id: number) => void
  done: boolean
}

export default function LessonDetail({ lessonId, onBack, onOpenExample, onOpenSimulator, onToggleDone, done }: LessonDetailProps) {
  const lesson = LESSONS.find(l => l.id === lessonId)
  const [showCode, setShowCode] = useState(true)

  if (!lesson) return null

  return (
    <div style={{
      flex: 1, overflow: 'auto', background: '#1e1e2e',
    }}>
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '28px 40px 60px' }}>
        {/* 顶部导航 */}
        <button onClick={onBack} style={{
          background: 'none', border: 'none', color: '#89b4fa',
          cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 16,
        }}>← 返回课程列表</button>

        {/* 标签 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <span style={{
            padding: '2px 10px', borderRadius: 4,
            background: '#313244', color: '#89b4fa', fontSize: 11,
          }}>Day {lesson.id}</span>
          <span style={{
            padding: '2px 10px', borderRadius: 4,
            background: '#313244', color: '#a6e3a1', fontSize: 11,
          }}>{lesson.topic}</span>
        </div>

        <h1 style={{ fontSize: 24, margin: '0 0 20px 0', color: '#cdd6f4' }}>
          {lesson.title}
        </h1>

        {/* 学习目标 */}
        <Section title="学习目标" color="#a6e3a1">
          <ul style={{ margin: 0, paddingLeft: 20, color: '#bac2de', fontSize: 14, lineHeight: 1.9 }}>
            {lesson.objective.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </Section>

        {/* 硬件准备 */}
        <Section title="硬件准备" color="#f9e2af">
          <ul style={{ margin: 0, paddingLeft: 20, color: '#bac2de', fontSize: 14, lineHeight: 1.9 }}>
            {lesson.hardware.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </Section>

        {/* 讲解 */}
        <Section title="知识讲解" color="#89b4fa">
          {lesson.theory.map((t, i) => (
            <p key={i} style={{ margin: '8px 0', color: '#bac2de', fontSize: 14, lineHeight: 1.8 }}>{t}</p>
          ))}
        </Section>

        {/* 完整代码 */}
        {lesson.code && (
          <Section title="完整源码" color="#cba6f7">
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={() => setShowCode(!showCode)}
                style={{
                  background: 'none', border: '1px solid #45475a', borderRadius: 4,
                  color: '#a6adc8', cursor: 'pointer', fontSize: 12, padding: '2px 10px',
                }}
              >
                {showCode ? '折叠代码' : '展开代码'}
              </button>
              {lesson.codeFile && (
                <span style={{ marginLeft: 10, fontSize: 12, color: '#6c7086' }}>📄 {lesson.codeFile}</span>
              )}
            </div>
            {showCode && <CodeBlock code={lesson.code} />}
          </Section>
        )}

        {/* 预期结果 */}
        <Section title="预期结果" color="#fab387">
          <ul style={{ margin: 0, paddingLeft: 20, color: '#bac2de', fontSize: 14, lineHeight: 1.9 }}>
            {lesson.expected.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </Section>

        {/* 动手练习 */}
        <Section title="动手练习" color="#f38ba8">
          <ul style={{ margin: 0, paddingLeft: 20, color: '#bac2de', fontSize: 14, lineHeight: 1.9 }}>
            {lesson.practice.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </Section>

        {/* 操作按钮 */}
        <div style={{
          marginTop: 32, paddingTop: 20, borderTop: '1px solid #313244',
          display: 'flex', gap: 12, flexWrap: 'wrap',
        }}>
          {lesson.codeFile && (
            <>
              <button
                onClick={() => onOpenExample(lesson.codeFile!)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: '#89b4fa', color: '#1e1e2e', fontWeight: 600, cursor: 'pointer', fontSize: 13,
                }}
              >
                📄 在编辑器打开
              </button>
              <button
                onClick={() => onOpenSimulator(lesson.codeFile!)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: '#a6e3a1', color: '#1e1e2e', fontWeight: 600, cursor: 'pointer', fontSize: 13,
                }}
              >
                ▶ 软件内仿真
              </button>
            </>
          )}
          <button
            onClick={() => onToggleDone(lesson.id)}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: done ? '#45475a' : '#f9e2af', color: done ? '#a6adc8' : '#1e1e2e',
              fontWeight: 600, cursor: 'pointer', fontSize: 13,
            }}
          >
            {done ? '✓ 已完成' : '标记为完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
