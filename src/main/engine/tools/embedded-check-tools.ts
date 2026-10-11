/**
 * 嵌入式时序/勘误校验工具（NeuralInverse #10）：formula_check + errata_check。
 * 写裸寄存器 / 配时钟 / 改外设前先调，避免凭记忆写错分频或踩已记录硅错。
 * 复用 services/formulaCheck 与 services/errataService，单一真相源。
 */
import type { ToolDefinition, ToolResult } from '../types'
import { checkFormula } from '../../services/formulaCheck'
import { queryErrata } from '../../services/errataService'

const formulaCheckTool: ToolDefinition = {
  name: 'formula_check',
  description:
    '校验嵌入式时序公式：UART 波特率 / 定时器 / PLL / PWM 的时钟分频是否可达目标值，返回实际频率、误差(Hz/ppm) 与建议寄存器值。写时钟/波特率/定时器相关寄存器前必须先用它验证分频，禁止凭记忆算。',
  category: 'read',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: '校验类型', enum: ['baud', 'timer', 'pll', 'pwm'] },
      target: { type: 'number', description: '目标值：baud=目标波特率, timer/pwm/pll=目标频率(Hz)' },
      clock: { type: 'number', description: '输入时钟频率(Hz)，如 APB 80MHz=80000000' },
      mode: { type: 'string', description: 'UART 用：standard=16x 采样, double=8x 采样(U2X)', enum: ['standard', 'double'] },
      tolerancePpm: { type: 'number', description: '允许误差阈值(ppm)，默认 2000（0.2%）' },
    },
    required: ['kind', 'target', 'clock'],
  },
  execute: async (args): Promise<ToolResult> => {
    try {
      const r = checkFormula(
        String(args.kind || ''),
        Number(args.target),
        Number(args.clock),
        { mode: args.mode === 'double' ? 'double' : 'standard', tolerancePpm: args.tolerancePpm != null ? Number(args.tolerancePpm) : 2000 }
      )
      return { ok: true, content: JSON.stringify(r, null, 2) }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  },
}

const errataCheckTool: ToolDefinition = {
  name: 'errata_check',
  description:
    '查芯片勘误表(errata)：给定芯片家族/型号与可选关键词，返回已知硅错、workaround、修复版本与来源。写外设配置前先查，避免踩已记录 errata。注意：命中条目须向厂商 errata sheet 二次核对。',
  category: 'read',
  parameters: {
    type: 'object',
    properties: {
      chip: { type: 'string', description: '芯片家族/型号，如 esp32 / esp32s3 / stm32f4' },
      keyword: { type: 'string', description: '可选，按外设/关键词过滤，如 uart / adc / gpio' },
    },
    required: ['chip'],
  },
  execute: async (args): Promise<ToolResult> => {
    try {
      const list = queryErrata(String(args.chip || ''), args.keyword ? String(args.keyword) : undefined)
      if (!list.length) {
        return {
          ok: true,
          content: `未收录 ${args.chip} 的 errata（库为种子，需按厂商 errata sheet 扩充；这不表示芯片无 errata，写关键外设前请人工核对官方文档）。`,
        }
      }
      return { ok: true, content: JSON.stringify(list, null, 2) }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  },
}

export const embeddedCheckTools: ToolDefinition[] = [formulaCheckTool, errataCheckTool]
