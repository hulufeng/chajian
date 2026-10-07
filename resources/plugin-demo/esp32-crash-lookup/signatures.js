'use strict'
/**
 * ESP32 崩溃签名知识库（纯数据 + 匹配，可被自检直接测）。
 *
 * 为什么单独做插件：宿主已有 analyze_crash 工具，但它是「按正则猜」，
 * 这里做成可查阅、可扩展的签名库，且**完全离线**——设备在实验室里没网时也能查。
 * 每条签名给出：触发原因 + 自查步骤 + 修复建议 + 地址解码命令。
 */

/** @typedef {{id:string,title:string,match:RegExp,cause:string,steps:string[],fix:string[],decode?:string}} CrashSignature */

/** @type {CrashSignature[]} */
const SIGNATURES = [
  {
    id: 'guru-meditation',
    title: 'Guru Meditation 错误（panic）',
    match: /Guru Meditation Error|Crashdump esp32|abort\(\) was called|assertion failed/i,
    cause: '程序主动 panic 或断言失败。ESP32 没有 OS 兜底，panic 后直接重启，所以看不到「崩溃现场」以外的上下文。',
    steps: [
      '看崩溃码（如 0x1e=__builtin_trap、0x80000003=中断异常）',
      '用下方 addr2line 把 PC 地址译回源码行',
      '若栈里有 FreeRTOS 任务名，问题通常在该任务里'
    ],
    fix: [
      '给可能为空的指针加判空（尤其 WiFi/BLE 回调里的请求句柄）',
      '别在 loop() 里直接 dereference 可能失败的返回值',
      '加 esp_task_wdt 或缩短看门狗超时，避免长时间阻塞喂狗'
    ],
    decode: 'xtensa-esp32-elf-addr2line -pfiaC -e firmware.elf 0x400d1234 0x400d5678'
  },
  {
    id: 'backtrace',
    title: 'Backtrace 栈回溯失败',
    match: /Backtrace:.*(0x[0-9a-f]{8}|<corrupt>)|Stack memory is corrupted|Malloc.*abort/i,
    cause: '栈被写坏或动态内存耗尽。栈溢出通常在中断里发生但现场不打印（中断栈很小）。',
    steps: ['看 backtrace 前几帧是否都是同一函数（递归爆栈）', '检查是否有大数组分配在栈上（如 char buf[8192]）'],
    fix: [
      '把大数组挪到静态/堆上（static 或 malloc）',
      '避免无终止条件的递归',
      '加大任务栈：xTaskCreate(..., 4096, ...) 或在 sdkconfig 里调大'
    ],
    decode: 'xtensa-esp32-elf-addr2line -pfiaC -e firmware.elf <backtrace 里的地址列表>'
  },
  {
    id: 'watchdog',
    title: 'Task watchdog 超时 / WDT',
    match: /Task watchdog|watchdog.*timeout|Interrupt wdt|Task WDT/i,
    cause: '任务长时间不让出 CPU，或死循环里没喂狗。常见于在 loop() 里做长延时、一次性处理大量数据、或阻塞在 delay()。',
    steps: ['确认是哪个任务超时（提示里会有任务名）', '检查该任务里有没有长时间不 yield 的循环'],
    fix: [
      '长耗时工作拆片：每轮做一点，然后 vTaskDelay(1) 让出 CPU',
      '别在 loop() 里用 delay(ms) 做长等待，改成非阻塞状态机',
      'WiFi/BLE 回调里别做重活，只设标志位，主循环里处理'
    ]
  },
  {
    id: 'brownout',
    title: 'Brownout 欠压复位',
    match: /Brownout detector was triggered|brownout.*reset/i,
    cause: '供电电压被拉低。瞬间大电流（WiFi 发射、电机启动、舵机）导致 3.3V 轨跌落。',
    steps: ['测量 3.3V 在 WiFi 发射瞬间的跌落幅度', '确认电源额定电流是否够，线材是否太细太长'],
    fix: [
      '在 3.3V 与 GND 之间加 470µF~1000µF 电容（靠近模块）',
      '电源换更大电流的（建议留 2 倍余量）',
      '别给舵机/电机直接接开发板 3.3V，用独立电源并共地'
    ]
  },
  {
    id: 'stack-overflow',
    title: 'Stack overflow',
    match: /Stack overflow/i,
    cause: '栈溢出。ESP32 主任务默认栈只有 3.5KB 左右，printf/浮点/深递归都很吃栈。',
    steps: ['看溢出的任务名', '检查该任务里的局部数组与递归深度'],
    fix: [
      '用 xTaskCreate 显式给任务更大栈（建议 ≥4096）',
      '避免在栈上开大数组；用 static 或堆',
      '减少 printf 的浮点格式化（-u _printf_float 会显著加大栈占用）'
    ]
  },
  {
    id: 'reboot-loop',
    title: 'rst:0x 复位原因解读',
    match: /rst:0x(\w+) .*(_[A-Z_]+)|rstr:.*rst:/i,
    cause: '复位原因编码。0x1=上电、0x3=软件复位、0x4=看门狗、0x5=其他、0x6=深度睡眠、0x9=JTAG/ brownout 常映射为 0x3 + panic 组合。',
    steps: ['把 rst:0x 后的数字查表对应原因', '若是软件复位但没看到 panic，通常是 esp_restart() 被显式调用'],
    fix: [
      '0x1 上电复位：正常，冷启动',
      '0x3 软件复位：查 esp_restart() 调用点',
      '0x4 看门狗：见 watchdog 条目',
      '若伴随 panic + backtrace：见 guru-meditation 条目'
    ]
  },
  {
    id: 'wifi-fail',
    title: 'WiFi 连接失败/反复重连',
    match: /wifi.*(fail|disconnect|reconnect)|bssid.*not found|reason=\d{3}/i,
    cause: 'WiFi 连接不稳定或认证失败。reason=201 是密码错，reason=15 是 4 次握手超时（信号或干扰问题）。',
    steps: ['确认 ESP32 与 AP 的距离/信道', '检查是否 5GHz 频段（ESP32 只支持 2.4GHz）'],
    fix: [
      'ESP32 仅支持 2.4GHz，双频合一的路由器需手动指定 2.4G',
      '加 reconnection 退避（指数退避，避免疯狂重连耗电）',
      'reason=201 → 核对密码；reason=15 → 换信道/靠近 AP'
    ]
  },
  {
    id: 'flash-error',
    title: 'Flash / 启动失败',
    match: /Invalid header|flash read error|MD5 of data abort|boot loop|No bootable/i,
    cause: '固件损坏或写入中断。也可能是 flash 被写保护或分区表不匹配。',
    steps: ['用 esptool 读一次 flash 校验', '确认分区表与固件大小匹配（OTA 分区不够会启动失败）'],
    fix: [
      '重新烧录（整片擦除后再写：esptool.py erase_flash）',
      '确认分区表给了 app 足够空间（arduino-cli compile --show-properties 看分区）',
      '检查 flash 供电与接触（杜邦线太细在大固件时可能压降）'
    ]
  },
  {
    id: 'heap-exhaust',
    title: '堆内存耗尽',
    match: /heap_caps_alloc.*fail|alloc.*failed|out of memory|not enough memory/i,
    cause: '动态分配失败。碎片化或长期泄漏累积导致。',
    steps: ['打印 heap_caps_get_free_size(MALLOC_CAP_INTERNAL) 看剩余', '排查是否有长生命周期对象一直被引用'],
    fix: [
      '长生命周期数据用静态分配或固定缓冲池，不要频繁 malloc/free',
      '避免在循环里创建大对象（JSON/字符串拼接）——提到循环外复用',
      '用 heap_caps_print_statistics 看碎片情况'
    ]
  },
  {
    id: 'no-response',
    title: '串口无输出 / 程序看起来没跑',
    match: /^\s*$/,
    cause: '固件没启动、波特率不对、或卡在启动早期（串口没初始化成功）。',
    steps: ['试 115200 与 921600 两种常见波特率', '确认 GPIO0/EN 引脚接对（IO0 拉低进下载模式）'],
    fix: [
      '按住 BOOT 键上电再松，可强制进下载模式并看到早期日志',
      'ESP32-S3/C3 用的是 USB-CDC 串口，端口可能与芯片串口不同（看设备管理器）',
      '确认代码里有 Serial.begin(...) 且没有长时间阻塞在 setup 最前面'
    ]
  }
]

/**
 * 在文本里查找命中的签名。
 * @returns {{hit: CrashSignature|null, all: CrashSignature[]}}
 */
function lookup(text) {
  const s = String(text || '')
  const all = SIGNATURES.filter((sig) => sig.match.test(s))
  // 命中最"具体"的优先：签名越靠前越具体（用顺序代表优先级）
  return { hit: all[0] || null, all }
}

/** 列出全部签名的概要 */
function listAll() {
  return SIGNATURES.map((s) => ({ id: s.id, title: s.title }))
}

/** 把一条签名渲染成可读文本 */
function render(sig) {
  const lines = [`【${sig.title}】`, '', '原因：', sig.cause, '', '自查步骤：']
  sig.steps.forEach((x, i) => lines.push(`  ${i + 1}. ${x}`))
  lines.push('', '修复建议：')
  sig.fix.forEach((x) => lines.push(`  · ${x}`))
  if (sig.decode) {
    lines.push('', '地址解码（把 PC 译回源码行）：')
    lines.push(`  ${sig.decode}`)
  }
  return lines.join('\n')
}

module.exports = { SIGNATURES, lookup, listAll, render }