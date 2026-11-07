/**
 * 开发板管理 - FQBN 映射（@bubaicode/core 模块，主进程编译链路实际使用）
 *
 * 2026-10-17：从占位骨架升级为真实可用模块——
 * 1) 扩充常用 ESP32 / Arduino / STM32 板型映射；
 * 2) 新增 guessFQBN：按 sketch 文件名/内容/目录关键词推断 FQBN，
 *    供 compile:arduino / compile:upload 在 fqbn 缺失时兜底，无需先 select_board。
 */
const BOARD_MAP = {
  // ESP32 系列（Arduino 核心 esp32:esp32）
  'esp32': 'esp32:esp32:esp32',
  'esp32-s2': 'esp32:esp32:esp32s2',
  'esp32-s3': 'esp32:esp32:esp32s3',
  'esp32-c3': 'esp32:esp32:esp32c3',
  'esp32-c6': 'esp32:esp32:esp32c6',
  'esp32-h2': 'esp32:esp32:esp32h2',
  'esp32-pico': 'esp32:esp32:esp32pico',
  // Arduino AVR
  'uno': 'arduino:avr:uno',
  'nano': 'arduino:avr:nano',
  'mega': 'arduino:avr:mega',
  'micro': 'arduino:avr:micro',
  'leonardo': 'arduino:avr:leonardo',
  // STM32（Arduino 核心 stm32duino）
  'stm32': 'stm32:stm32:stm32',
  'stm32-f103': 'stm32:stm32:genericSTM32F103C8'
};

class Board {
  static getFQBN(boardId) { return BOARD_MAP[boardId] || boardId; }
  static list() { return Object.keys(BOARD_MAP); }

  /**
   * 按 sketch 路径/内容/文件名关键词推断 FQBN（无 select_board 时的兜底）
   * @param {string} sketchPath  sketch 目录或 .ino/.c/.cpp 文件路径
   * @param {string} [content]   sketch 源码内容（可选，用于识别开发板型号宏）
   * @returns {string|null} 推断出的 FQBN，无法推断时返回 null
   */
  static guessFQBN(sketchPath, content) {
    const haystack = String(sketchPath || '').toLowerCase() + '|' + String(content || '').toLowerCase();
    const has = (re) => re.test(haystack);

    // 具体型号优先（长关键词在前，避免 esp32 命中所有变体）
    if (has(/esp32[-_]?s3|esp32s3|esp32-s3/)) return 'esp32:esp32:esp32s3';
    if (has(/esp32[-_]?s2|esp32s2|esp32-s2/)) return 'esp32:esp32:esp32s2';
    if (has(/esp32[-_]?c3|esp32c3|esp32-c3/)) return 'esp32:esp32:esp32c3';
    if (has(/esp32[-_]?c6|esp32c6|esp32-c6/)) return 'esp32:esp32:esp32c6';
    if (has(/esp32[-_]?h2|esp32h2|esp32-h2/)) return 'esp32:esp32:esp32h2';
    if (has(/esp32/)) return 'esp32:esp32:esp32';

    if (has(/stm32f103|stm32-f103|bluepill|blue.?pill/)) return 'stm32:stm32:genericSTM32F103C8';
    if (has(/stm32/)) return 'stm32:stm32:stm32';

    if (has(/mega2560|arduino mega|mega\b/)) return 'arduino:avr:mega';
    if (has(/leonardo/)) return 'arduino:avr:leonardo';
    if (has(/micro/)) return 'arduino:avr:micro';
    if (has(/nano/)) return 'arduino:avr:nano';
    if (has(/uno|arduino/)) return 'arduino:avr:uno';

    return null;
  }
}
module.exports = Board;
