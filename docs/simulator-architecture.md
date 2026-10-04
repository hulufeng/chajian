# CodeLab ESP32 仿真器 — 自研技术方案 v3

> 核心：用户写的 .ino 代码直接在软件里跑，改代码立即生效

---

## 1. 方案核心

**不再预设 TS 示例。写一个 .ino → JS 转译器，把用户写的 Arduino C++ 代码自动转成 VirtualRuntime 调用执行。**

用户在编辑器里写：
```cpp
#define LED 8
void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
}
```

点 ▶，转译器自动生成并执行：
```javascript
const LED = 8;
async function setup(rt) {
  rt.gpio.pinMode(8, 'OUTPUT');
  rt.uart.begin(115200);
}
async function loop(rt) {
  rt.gpio.digitalWrite(8, 1);
  await rt.delay(500);
  rt.gpio.digitalWrite(8, 0);
  await rt.delay(500);
}
```

改代码？再点一次 ▶，立刻看到新效果。

---

## 2. 转译器设计

### 2.1 支持的 API 映射

| Arduino 写法 | 转译为 |
|-------------|--------|
| `pinMode(p, OUTPUT)` | `rt.gpio.pinMode(p, 'OUTPUT')` |
| `digitalWrite(p, HIGH)` | `rt.gpio.digitalWrite(p, 1)` |
| `digitalWrite(p, LOW)` | `rt.gpio.digitalWrite(p, 0)` |
| `digitalRead(p)` | `rt.gpio.digitalRead(p)` |
| `analogRead(pin)` | `rt.adc.read(pin)` |
| `analogWrite(p, v)` | `rt.pwm.analogWrite(p, v)` |
| `delay(ms)` | `await rt.delay(ms)` |
| `millis()` | `rt.millis()` |
| `Serial.begin(b)` | `rt.uart.begin(b)` |
| `Serial.print(x)` | `rt.uart.print(x)` |
| `Serial.println(x)` | `rt.uart.println(x)` |
| `Serial.printf(fmt, ...)` | `rt.uart.printf(fmt, ...)` |
| `#define X val` | `const X = val` |

### 2.2 库的 mock

| 库 | 处理方式 |
|---|---------|
| `#include <Wire.h>` | 自动引入 I2C mock，`Wire.begin()` → `rt.wire.begin()`，`Wire.beginTransmission(addr)` → `rt.wire.beginTransmission(addr)` 等 |
| `#include <Adafruit_SSD1306.h>` | 自动转发到 I2C 0x3C，`display.print()` / `display.display()` 画到 OLED |
| 其他 `#include` | 警告"此库不支持模拟，将走烧录模式" |

### 2.3 转译步骤

```
1. 预处理：去掉 #include，记录用到的库
2. 常量：#define X val → const X = val
3. 提取 setup() 和 loop() 函数体
4. API 调用替换（正则）
5. delay() 前面加 await
6. 包成 async function(rt)
7. 用 new Function() 执行
```

### 2.4 代码结构

```typescript
// simulator/transpiler.ts

export function transpile(inoCode: string): { setup: Function; loop: Function } {
  let code = inoCode

  // 1. #define → const
  code = code.replace(/#define\s+(\w+)\s+(.+)/g, 'const $1 = $2;')

  // 2. HIGH/LOW/OUTPUT/INPUT → 字面量
  code = code.replace(/\bHIGH\b/g, '1')
  code = code.replace(/\bLOW\b/g, '0')
  code = code.replace(/\bOUTPUT\b/g, "'OUTPUT'")
  code = code.replace(/\bINPUT\b/g, "'INPUT'")
  code = code.replace(/\bINPUT_PULLUP\b/g, "'INPUT_PULLUP'")

  // 3. API 替换
  code = code.replace(/Serial\.begin\((\d+)\)/g, 'rt.uart.begin($1)')
  code = code.replace(/Serial\.print\((.*?)\)/g, 'rt.uart.print($1)')
  code = code.replace(/Serial\.println\((.*?)\)/g, 'rt.uart.println($1)')
  code = code.replace(/Serial\.printf\((.*?)\)/g, 'rt.uart.printf($1)')
  code = code.replace(/pinMode\((\w+),\s*(\w+)\)/g, 'rt.gpio.pinMode($1, $2)')
  code = code.replace(/digitalWrite\((\w+),\s*(\w+)\)/g, 'rt.gpio.digitalWrite($1, $2)')
  code = code.replace(/digitalRead\((\w+)\)/g, 'rt.gpio.digitalRead($1)')
  code = code.replace(/analogRead\((\w+)\)/g, 'rt.adc.read($1)')
  code = code.replace(/analogWrite\((\w+),\s*(\w+)\)/g, 'rt.pwm.analogWrite($1, $2)')
  code = code.replace(/millis\(\)/g, 'rt.millis()')

  // 4. delay → await delay
  code = code.replace(/delay\((\d+)\)/g, 'await rt.delay($1)')

  // 5. 提取 setup 和 loop 函数体
  const setupMatch = code.match(/void\s+setup\s*\(\s*\)\s*\{([\s\S]*?)\n\}/)
  const loopMatch = code.match(/void\s+loop\s*\(\s*\)\s*\{([\s\S]*?)\n\}/)

  const setupBody = setupMatch ? setupMatch[1] : ''
  const loopBody = loopMatch ? loopMatch[1] : ''

  // 6. 提取全局常量（#define 已转成 const）
  const globalConsts = code.match(/const\s+\w+\s*=\s*[^;]+;/g)?.join('\n') || ''

  // 7. 生成函数
  const setupFn = new Function('rt', `${globalConsts}\n${setupBody}; return async () => {}`)
  const loopFn = new Function('rt', `${globalConsts}\n${loopBody}`)

  return {
    setup: async (rt: any) => {
      // 执行 setup
      const fn = new Function('rt', `${globalConsts}\n${setupBody}\nreturn async () => {}`)
      await fn(rt)()
    },
    loop: async (rt: any) => {
      const fn = new Function('rt', `${globalConsts}\n${loopBody}`)
      await fn(rt)
    }
  }
}
```

---

## 3. 用户体验

```
用户在编辑器写 .ino 代码
        │
        ▼
点 ▶ 按钮
        │
        ▼
transpile(code) → 检查是否用了不支持的库
        │
   ┌────┴────┐
   │         │
支持模拟    需要 WiFi/BLE/NeoPixel
   │         │
   ▼         ▼
VirtualRuntime   提示"需要烧录到板子"
立即跑           [编译并烧录] 按钮
   │
   ▼
LED 闪 / 串口输出 / OLED 显示
```

**改代码后再点 ▶，重新转译，立即看到新效果。**

---

## 4. 真实感提升

### 4.1 ESP32 板子外观

- 蓝色 PCB (#1a4b8c)
- ESP32-WROOM-32 金属屏蔽罩
- 真实引脚标签（GPIO0-GPIO48 金色排针）
- USB 口

### 4.2 真实元件

- LED：透明环氧封装视觉，亮时发光
- 按钮：蘑菇头按钮
- OLED：0.96" 蓝 OLED，真实像素渲染
- 电位器：旋转旋钮视觉

### 4.3 面包板

- 白色面包板，带孔位
- 红蓝电源轨线
- 元件插在面包板上的视觉

---

## 5. 文件结构

```
simulator/
├── VirtualRuntime.ts      # 核心
├── GPIOBank.ts
├── UARTPort.ts
├── I2CBus.ts
├── ADCPeripheral.ts
├── PWMPeripheral.ts
├── font5x7.ts            # OLED 字模
├── transpiler.ts         # .ino → JS 转译器（新核心）
└── index.ts
```

---

## 6. 开发步骤

1. **写 transpiler.ts** — 正则替换 + new Function 执行（2h）
2. **写 font5x7.ts** — OLED 5x7 ASCII 字模（1h）
3. **改 SimulatorPanel** — 从读内置示例改成读编辑器当前文件（1h）
4. **测试** — 用户写 blink/serial/pwm/button 代码，点运行看效果（1h）
5. **错误处理** — 转译失败时显示友好错误（0.5h）

**总计 5.5 小时**

---

## 7. 限制（诚实说明）

- 不支持复杂 C++ 语法（类、继承、函数指针）
- 不支持 `#include <WiFi.h>` 等硬件库（自动切烧录模式）
- for/while 循环能跑（JS 原生支持）
- if/else 能跑
- 教学场景（前 20 课）全部够用
