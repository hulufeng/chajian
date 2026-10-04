// 结构化测试运行器（对齐 TrieCode Test Runner）
// 自动探测项目测试框架 → 运行 → 解析结果 → 按 断言/编译/超时/崩溃 分类失败
// 让 agent 能"自己跑测试、看懂结果、逐类修复"，而不是只拿到一坨终端文本
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCommand } from '../../services/commandService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

type FailKind = 'assertion' | 'compile' | 'timeout' | 'crash' | 'unknown'

interface DetectedFramework {
  framework: 'pytest' | 'unittest' | 'npm' | 'go' | 'cargo' | 'ctest' | 'platformio'
  language: string
  command: string
  detect: (root: string) => boolean
}

// ── 框架探测（按优先级）──
const FRAMEWORKS: DetectedFramework[] = [
  {
    framework: 'cargo',
    language: 'rust',
    command: 'cargo test --no-fail-fast -- --nocapture',
    detect: (root) => existsSync(join(root, 'Cargo.toml'))
  },
  {
    framework: 'go',
    language: 'go',
    command: 'go test ./... -v',
    detect: (root) => existsSync(join(root, 'go.mod'))
  },
  {
    framework: 'ctest',
    language: 'cpp',
    command: 'ctest --output-on-failure',
    detect: (root) => existsSync(join(root, 'CMakeLists.txt')) && existsSync(join(root, 'build'))
  },
  {
    framework: 'platformio',
    language: 'arduino',
    command: 'pio test',
    detect: (root) => existsSync(join(root, 'platformio.ini')) && existsSync(join(root, 'test'))
  },
  {
    framework: 'npm',
    language: 'javascript',
    command: 'npm test --silent',
    detect: (root) => {
      const pkg = join(root, 'package.json')
      if (!existsSync(pkg)) return false
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8'))
        return Boolean(j.scripts && typeof j.scripts.test === 'string' && j.scripts.test.trim() !== '')
      } catch {
        return false
      }
    }
  },
  {
    framework: 'pytest',
    language: 'python',
    command: 'python -m pytest -v',
    detect: (root) => {
      if (
        existsSync(join(root, 'pytest.ini')) ||
        existsSync(join(root, 'pyproject.toml')) && readFileSync(join(root, 'pyproject.toml'), 'utf8').includes('pytest') ||
        existsSync(join(root, 'setup.cfg')) && readFileSync(join(root, 'setup.cfg'), 'utf8').includes('pytest')
      ) return true
      // tests 目录里出现 pytest 风格（def test_ 且无 unittest.TestCase）优先 pytest
      return hasPythonTests(root)
    }
  },
  {
    framework: 'unittest',
    language: 'python',
    command: 'python -m unittest discover -v',
    detect: (root) => hasPythonTests(root)
  }
]

function hasPythonTests(root: string): boolean {
  for (const dir of ['tests', 'test']) {
    const p = join(root, dir)
    if (!existsSync(p)) continue
    try {
      const walk = (d: string, depth: number): boolean => {
        if (depth > 3) return false
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const fp = join(d, e.name)
          if (e.isDirectory()) { if (walk(fp, depth + 1)) return true }
          else if (e.name.startsWith('test_') && e.name.endsWith('.py')) return true
        }
        return false
      }
      if (walk(p, 0)) return true
    } catch { /* ignore */ }
  }
  return false
}

function detectFramework(root: string): DetectedFramework | null {
  for (const f of FRAMEWORKS) {
    try {
      if (f.detect(root)) return f
    } catch { /* 探测失败则尝试下一个 */ }
  }
  return null
}

// ── 执行命令并捕获全部输出（带超时）──
function execCapture(command: string, cwd: string, timeoutMs: number, onOutput?: (s: string) => void):
  Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ code: -1, output, timedOut: true })
    }, timeoutMs)
    runCommand(
      command,
      cwd,
      (chunk) => { output += chunk; onOutput?.(chunk) },
      (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, output, timedOut: false })
      }
    )
  })
}

// ── 失败分类 ──
function classifyFailure(output: string, timedOut: boolean): FailKind {
  if (timedOut) return 'timeout'
  const o = output
  if (/segmentation fault|SIGSEGV|core dumped|panic(?::|\s)|fatal exception|aborted|exit status 0xc0000005/i.test(o)) return 'crash'
  if (/ModuleNotFoundError|ImportError|Cannot find module|Cannot find package|undefined reference|fatal error|SyntaxError|Compilation error|compilation failed|error\[E\d+\]|cannot find symbol|build failed|LINK : fatal|未定义的引用|编译失败/i.test(o)) return 'compile'
  if (/timed? ?out|deadline exceeded|超时/i.test(o)) return 'timeout'
  if (/AssertionError|assert |--- FAIL:|^FAILED|✕|expected:|but was:|not equal|should |断言/i.test(o)) return 'assertion'
  return 'unknown'
}

const KIND_LABEL: Record<FailKind, string> = {
  assertion: '断言失败（逻辑不符合预期，检查被测代码的分支/返回值）',
  compile: '编译/导入错误（缺少依赖、类型错误、语法错误，先让代码能构建）',
  timeout: '超时（可能死循环、IO 阻塞或测试等待过久）',
  crash: '崩溃（段错误/panic/未捕获异常，检查空指针、数组越界、资源释放）',
  unknown: '未归类失败（查看原始输出定位）'
}

interface ParsedSummary {
  passed: number | null
  failed: number | null
  errors: number | null
  skipped: number | null
  failedCases: string[]
}

function parseOutput(framework: string, output: string): ParsedSummary {
  const s: ParsedSummary = { passed: null, failed: null, errors: null, skipped: null, failedCases: [] }
  const num = (re: RegExp): number | null => {
    const m = output.match(re)
    return m ? parseInt(m[1], 10) : null
  }

  if (framework === 'pytest' || framework === 'unittest') {
    // pytest: "=== 1 failed, 3 passed, 2 errors, 1 skipped in 0.5s ==="
    s.failed = num(/(\d+)\s+failed/)
    s.passed = num(/(\d+)\s+passed/)
    s.errors = num(/(\d+)\s+errors?/)
    s.skipped = num(/(\d+)\s+skipped/)
    // 失败用例：pytest "FAILED tests/test_auth.py::test_x - AssertionError" 或 "F\n____ test_x ____"
    const re = /(?:FAILED|ERROR)\s+([^\s\n]+)(?:\s*-\s*(.+))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(output)) !== null && s.failedCases.length < 20) {
      s.failedCases.push(`${m[1]}${m[2] ? ' — ' + m[2].slice(0, 160) : ''}`)
    }
    // unittest: "FAIL: test_x (tests.test_auth.TestX)"
    const re2 = /(?:FAIL|ERROR):\s+(\S+)/g
    while ((m = re2.exec(output)) !== null && s.failedCases.length < 20) {
      if (!s.failedCases.includes(m[1])) s.failedCases.push(m[1])
    }
    // unittest 汇总行："FAILED (failures=1, errors=2)" / "Ran N tests ... OK"
    if (s.failed === null) s.failed = num(/failures=(\d+)/)
    if (s.errors === null) s.errors = num(/errors=(\d+)/)
    const ran = num(/Ran\s+(\d+)\s+tests?/)
    if (ran !== null && s.passed === null) {
      s.passed = Math.max(0, ran - (s.failed ?? 0) - (s.errors ?? 0))
    }
  } else if (framework === 'go') {
    const fails = output.match(/--- FAIL: (\S+)/g) || []
    s.failed = fails.length
    const oks = output.match(/--- PASS: (\S+)/g) || []
    s.passed = oks.length
    s.failedCases = fails.map((f) => f.replace('--- FAIL: ', '').trim())
    if (/^FAIL\s/m.test(output) && s.failed === 0) s.failed = 1
  } else if (framework === 'cargo') {
    // "test result: ok. 5 passed; 0 failed; 2 ignored;"（多个测试二进制各一行，累加）
    const blocks = output.match(/test result:.*$/gm) || []
    let p = 0, f = 0, ig = 0
    const pick = (b: string, re: RegExp): number => {
      const mm = re.exec(b)
      return mm ? parseInt(mm[1], 10) : 0
    }
    for (const b of blocks) {
      p += pick(b, /(\d+) passed/)
      f += pick(b, /(\d+) failed/)
      ig += pick(b, /(\d+) ignored/)
    }
    s.passed = p; s.failed = f; s.skipped = ig
    const re = /---- (\S+) stdout ----|test\s+(\S+)\s+\.\.\.\s+FAILED/g
    let m: RegExpExecArray | null
    while ((m = re.exec(output)) !== null && s.failedCases.length < 20) {
      const name = m[1] || m[2]
      if (name && !s.failedCases.includes(name)) s.failedCases.push(name)
    }
  } else if (framework === 'ctest') {
    s.passed = num(/(\d+)% tests passed/)
    s.failed = num(/(\d+) tests failed/)
    const failLines = output.match(/Test\s+#\d+:.*(Failed|FAIL).*/g) || []
    s.failedCases = failLines.slice(0, 20)
  } else {
    // npm / jest / mocha / vitest 通用：✓ / ✕ 或 "Tests: failed"
    const fail = output.match(/[✕×]\s*([^\n]+)/g) || []
    s.failed = fail.length || num(/(\d+)\s+(?:failed|failing)/)
    const pass = output.match(/[✓√]\s*[^\n]+/g) || []
    s.passed = pass.length || num(/(\d+)\s+passed/)
    s.failedCases = fail.map((f) => f.replace(/^[✕×]\s*/, '').trim()).slice(0, 20)
  }
  return s
}

export const runTests: ToolDefinition = {
  name: 'run_tests',
  description:
    '运行项目的测试套件。自动识别框架：Python(pytest/unittest)、Node(npm test/jest/vitest)、Go(go test)、Rust(cargo test)、C++(ctest)、PlatformIO。' +
    '返回结构化结果（通过/失败/错误/跳过数量、失败用例清单、失败分类：断言/编译/超时/崩溃）。' +
    '当你修改了代码、或用户要求跑测试/验证时优先使用本工具，而不是用 terminal 手动敲测试命令。测试失败时，依据"失败分类"和失败用例逐个修复后再次调用本工具，直到全部通过。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目根目录，默认当前工作项目' },
      framework: { type: 'string', description: '可选，强制指定框架：pytest/unittest/npm/go/cargo/ctest/platformio，默认自动探测' },
      timeout: { type: 'number', description: '超时毫秒，默认 120000' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = args.path ? resolve(ctx.projectRoot || ctx.cwd, String(args.path)) : (ctx.projectRoot || ctx.cwd)
    const forced = args.framework ? String(args.framework) : ''
    const timeoutMs = Number(args.timeout) || 120000

    const fw = forced
      ? FRAMEWORKS.find((f) => f.framework === forced)
      : detectFramework(root)

    if (!fw) {
      return {
        ok: false,
        content: '',
        error: `未在 ${root} 探测到测试框架（没找到 Cargo.toml/go.mod/package.json(test脚本)/pytest/tests 等）。` +
          '若项目确有测试，请用 framework 参数显式指定，或用 terminal 工具手动运行测试命令。'
      }
    }

    ctx.onOutput?.(`\n[run_tests] 框架=${fw.framework} 命令=${fw.command}\n`)
    const { code, output, timedOut } = await execCapture(fw.command, root, timeoutMs, ctx.onOutput)
    const summary = parseOutput(fw.framework, output)
    const kind = classifyFailure(output, timedOut)

    const failedN = summary.failed ?? 0
    const errorN = summary.errors ?? 0
    const passedN = summary.passed
    const allPassed = !timedOut && code === 0 && failedN === 0 && errorN === 0

    const lines: string[] = []
    lines.push(`测试框架: ${fw.framework}（${fw.language}）`)
    lines.push(`命令: ${fw.command}`)
    lines.push(`退出码: ${code}${timedOut ? '（超时 ' + timeoutMs + 'ms）' : ''}`)
    lines.push(
      `结果: ${passedN === null ? '?' : passedN} 通过, ${failedN} 失败${errorN ? `, ${errorN} 错误` : ''}${summary.skipped ? `, ${summary.skipped} 跳过` : ''}`
    )

    if (!allPassed) {
      lines.push(`\n失败分类: ${kind} — ${KIND_LABEL[kind]}`)
      if (summary.failedCases.length > 0) {
        lines.push('\n失败用例:')
        for (const c of summary.failedCases) lines.push(`  - ${c}`)
      }
      lines.push('\n修复指引: 先按"失败分类"确定问题层级（编译错误先让它能构建；断言失败再核对逻辑），逐个失败用例定位，修复后重新调用 run_tests 验证，直到退出码为 0。')
    } else {
      lines.push('\n✓ 全部测试通过。')
    }

    // 原始输出尾部（保留细节，截断防超长）
    const tail = output.length > 3000 ? '\n\n原始输出（尾部 3000 字符）:\n' + output.slice(-3000) : '\n\n原始输出:\n' + output
    lines.push(tail)

    return {
      ok: allPassed,
      content: lines.join('\n'),
      data: {
        framework: fw.framework,
        language: fw.language,
        exitCode: code,
        timedOut,
        passed: passedN,
        failed: failedN,
        errors: errorN,
        skipped: summary.skipped,
        failKind: allPassed ? null : kind,
        failedCases: summary.failedCases
      }
    }
  }
}
