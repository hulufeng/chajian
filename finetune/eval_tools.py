#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_tools.py - 本地模型工具决策能力验收（训练前/后对比）

做法与 BubaiCode 线上一致：GBNF 约束 + 非流式（grammar 从 main/index.js 的 buildToolGbnf 实时抽取，
保证测的就是上线代码）。跑 4 类用例 x N 次，输出准确率。

用法：
  python eval_tools.py --model "D:\\BubaiCode\\models\\qwen2.5-coder-7b-instruct-q4_k_m.gguf" --repeat 3
  python eval_tools.py --model <微调后的GGUF> --repeat 5 --baseline <基线GGUF>
"""
import argparse
import json
import os
import re
import subprocess
import time
import http.client

APP_MAIN = os.environ.get(
    'BUBAI_MAIN',
    r'D:\work\daimaLABshiyanshi\codelab-desktop\desktop-app\main\index.js')
LLAMA_SERVER = os.environ.get(
    'LLAMA_SERVER',
    r'D:\work\daimaLABshiyanshi\codelab-desktop\desktop-app\dist\win-unpacked\resources\llama\llama-server.exe')

TOOLS = ['read_file', 'write_file', 'edit_file', 'terminal', 'run_test', 'list_files', 'search_files', 'install_plugin']

CASES = [
    # (期望工具或none, 用户消息)
    ('read_file', '先看一下 src/main.cpp 的内容'),
    ('read_file', 'main.cpp 里怎么初始化串口的？帮我看看'),
    ('write_file', '新建 src/blink.ino，写个每秒闪 LED 的程序'),
    ('edit_file', '把 src/main.cpp 里的 LED 引脚改成 GPIO5'),
    ('edit_file', '串口波特率从 9600 改成 115200'),
    ('terminal', 'arduino-cli 列出已连接的板卡'),
    ('run_test', '编译一下看看有没有报错'),
    ('run_test', '跑一下测试'),
    ('list_files', '这个项目里有哪些文件？'),
    ('search_files', '代码里哪里用到了 Serial.begin？'),
    ('none', '你好'),
    ('none', 'I2C 和 SPI 有什么区别？'),
    ('none', '中断服务函数为什么不能有返回值'),
    ('none', '帮我把 ESP32 的闪存分区表讲一下'),
]


def extract_fn(src, name):
    start = src.index(f'function {name}(')
    i = src.index('{', start)
    depth, end = 0, -1
    for j in range(i, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    return src[start:end]


def load_grammar(verbose=True):
    """用 node 执行 main/index.js 里真实的 buildToolGbnf，保证测的就是上线代码。

    不能用 exec() 在 Python 里跑：抽出来的 JS 函数带 `//` 行注释，Python 会当成整除
    运算符直接 SyntaxError（main/index.js 还是历史遗留的 GBK/UTF-8 混编，中文注释是乱码，
    但 JS 注释里的乱码字符对 node 无影响）。
    """
    data = open(APP_MAIN, 'rb').read()
    src = None
    for enc in ('utf-8', 'gb18030'):
        try:
            src = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if src is None:
        src = data.decode('utf-8', 'ignore')
    fn = extract_fn(src, 'buildToolGbnf')
    tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_grammar_gen.tmp.js')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(fn + '\nconsole.log(buildToolGbnf(' + json.dumps(TOOLS) + '));\n')
    try:
        r = subprocess.run(['node', tmp], capture_output=True, text=True, encoding='utf-8', errors='ignore')
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
    if r.returncode != 0:
        raise SystemExit('生成 grammar 失败（node）: ' + (r.stderr or '')[:600])
    g = r.stdout.strip()
    if verbose:
        print('grammar 来自上线代码，长度', len(g))
    return g


def start_server(model, lora=None):
    """lora：可选，GGUF 格式的 LoRA 适配器（llama.cpp 挂载到基座模型上，省 1.8GB 体积）"""
    subprocess.run(['taskkill', '/F', '/IM', 'llama-server.exe'], capture_output=True)
    time.sleep(1)
    cmd = [LLAMA_SERVER, '--model', model, '--port', '8080',
           '-ngl', '99', '-c', '4096', '--jinja']
    if lora:
        cmd += ['--lora', lora]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(300):
        try:
            c = http.client.HTTPConnection('127.0.0.1', 8080, timeout=2)
            c.request('GET', '/props')
            r = c.getresponse()
            body = r.read().decode('utf-8', 'ignore')
            c.close()
            if r.status == 200 and 'model_alias' in body:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def decide(grammar, user_msg):
    payload = json.dumps({
        'model': 'm',
        'messages': [{'role': 'user', 'content': user_msg}],
        'temperature': 0.1, 'max_tokens': 512, 'stream': False,
        'grammar': grammar,
        'chat_template_kwargs': {'enable_thinking': False},
    }).encode()
    for _ in range(40):
        c = http.client.HTTPConnection('127.0.0.1', 8080, timeout=90)
        c.request('POST', '/v1/chat/completions', payload, {'Content-Type': 'application/json'})
        r = c.getresponse()
        body = r.read().decode('utf-8', 'ignore')
        c.close()
        if r.status == 503:
            time.sleep(1)
            continue
        if r.status != 200:
            return None
        try:
            j = json.loads(body)
            content = (j['choices'][0]['message'].get('content') or '').strip()
            return json.loads(content)
        except Exception:
            return None
    return None


def run_eval(model, grammar, repeat, lora=None):
    print('启动引擎:', model, ('+ LoRA: ' + lora) if lora else '')
    if not start_server(model, lora):
        raise SystemExit('引擎启动失败')
    correct = total = 0
    fails = []
    for expect, msg in CASES:
        ok_n = 0
        for _ in range(repeat):
            r = decide(grammar, msg)
            if r and (r.get('tool') == expect):
                ok_n += 1
        total += repeat
        correct += ok_n
        mark = 'OK ' if ok_n == repeat else '!! '
        print(f'{mark}{expect:14s} {ok_n}/{repeat}  {msg[:30]}')
        if ok_n < repeat:
            fails.append((expect, msg, ok_n, repeat))
    subprocess.run(['taskkill', '/F', '/IM', 'llama-server.exe'], capture_output=True)
    print(f'\n总准确率: {correct}/{total} = {correct / total * 100:.1f}%')
    return correct / total, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='待测 GGUF 路径')
    ap.add_argument('--baseline', help='（可选）基线 GGUF，先跑基线再跑目标')
    ap.add_argument('--repeat', type=int, default=3)
    ap.add_argument('--lora', help='（可选）GGUF LoRA 适配器，挂到 --model/--baseline 之上')
    args = ap.parse_args()

    grammar = load_grammar()
    if args.baseline:
        print('===== 基线 =====')
        b_acc, b_fails = run_eval(args.baseline, grammar, args.repeat)
        print('\n===== 微调后 =====')
        f_acc, f_fails = run_eval(args.model, grammar, args.repeat, args.lora)
        print(f'\n提升: {b_acc * 100:.1f}% -> {f_acc * 100:.1f}%  (+{(f_acc - b_acc) * 100:.1f}pp)')
        if f_fails:
            print('仍失败用例:')
            for e, m, ok, rep in f_fails:
                print(f'  {e} {ok}/{rep} {m}')
    else:
        run_eval(args.model, grammar, args.repeat, args.lora)


if __name__ == '__main__':
    main()
