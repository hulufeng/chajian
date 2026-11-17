#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prepare_data.py - 把开源工具调用数据转成「决策 JSON」训练格式（对齐 BubaiCode GBNF 决策轮）

输入（可混合）：
  1. NousResearch/hermes-function-calling-v1 的 func-calling.json（ShareGPT 多轮对话）
     下载：https://hf-mirror.com/datasets/NousResearch/hermes-function-calling-v1/resolve/main/func-calling.json
  2. 本目录 bubaicode_tools_examples.jsonl（BubaiCode 真实工具手工样本，已是目标格式）

输出：
  train.jsonl / val.jsonl，每行 {"messages":[...]}，assistant 目标形如
  {"tool":"read_file","arguments":{...}} 或 {"tool":"none","arguments":{}}
  与 desktop-app/main/index.js buildToolGbnf 约束形状一致，训完即插即用。

用法：
  python prepare_data.py --hermes func-calling.json --bubaicode bubaicode_tools_examples.jsonl --out .
"""
import argparse
import json
import os
import random
import re

# hermes 数据集里 gpt 消息中的工具调用标签（用字符串拼接避免与本文档标记冲突）
TC_OPEN = '<' + 'tool_call' + '>'
TC_CLOSE = '</' + 'tool_call' + '>'
TC_RE = re.compile(re.escape(TC_OPEN) + r'\s*(.*?)\s*' + re.escape(TC_CLOSE), re.S)


def parse_first_tool_call(gpt_text):
    """从 hermes gpt 消息解析第一个工具调用 -> (name, args_dict)；没有则 None"""
    m = TC_RE.search(gpt_text or '')
    if not m:
        return None
    try:
        obj = json.loads(m.group(1))
    except Exception:
        return None
    if isinstance(obj, list):
        obj = obj[0] if obj else None
    if not isinstance(obj, dict):
        return None
    name = obj.get('name') or (obj.get('function') or {}).get('name')
    if not name:
        return None
    args = obj.get('arguments', obj.get('parameters', {}))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {'_raw': args}
    if not isinstance(args, dict):
        args = {}
    return name, args


def hermes_to_samples(path, max_samples=8000):
    """ShareGPT 多轮 -> 决策样本：每个带工具调用的 gpt 轮产出 条 (上文 -> 该轮决策)"""
    raw = open(path, 'rb').read().decode('utf-8', errors='ignore')
    dec = json.JSONDecoder()
    i = raw.index('[') + 1
    rows = []
    while True:
        while i < len(raw) and raw[i] in ' \n\r\t,':
            i += 1
        if i >= len(raw) or raw[i] == ']':
            break
        try:
            obj, i = dec.raw_decode(raw, i)
            rows.append(obj)
        except Exception:
            break
    print('hermes 原始对话:', len(rows))

    samples = []
    for conv in rows:
        turns = conv.get('conversations') or []
        system = ''
        msgs = []          # 已转换为 OpenAI 角色的上下文
        pending_user = None
        for t in turns:
            frm = t.get('from')
            val = t.get('value') or ''
            if frm == 'system':
                system = val
            elif frm in ('human', 'user'):
                msgs.append({'role': 'user', 'content': val})
            elif frm in ('tool', 'observation'):
                msgs.append({'role': 'tool', 'content': val[:2000]})
            elif frm in ('gpt', 'assistant'):
                call = parse_first_tool_call(val)
                if call:
                    name, args = call
                    target = json.dumps({'tool': name, 'arguments': args}, ensure_ascii=False)
                    # 该轮作为训练目标；上文 = system + 已有上下文
                    sample = ([{'role': 'system', 'content': system}] if system else []) + msgs + [
                        {'role': 'assistant', 'content': target}
                    ]
                    samples.append({'messages': sample})
                # gpt 文本轮也产出 none 样本（纯回复场景）
                else:
                    text_only = re.sub(r'\s+', ' ', val).strip()
                    if text_only:
                        sample = ([{'role': 'system', 'content': system}] if system else []) + msgs + [
                            {'role': 'assistant', 'content': '{"tool":"none","arguments":{}}'}
                        ]
                        samples.append({'messages': sample})
                # gpt 轮本身也进上下文（简化：只放纯文本部分，供后续轮参考）
                text_part = TC_RE.sub('', val).strip()
                if text_part:
                    msgs.append({'role': 'assistant', 'content': text_part[:2000]})
                else:
                    msgs.append({'role': 'assistant', 'content': '（已调用工具 ' + (call[0] if call else '?') + '）'})
        if len(samples) >= max_samples:
            break
    return samples[:max_samples]


def load_jsonl(path):
    out = []
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hermes', help='hermes func-calling.json 路径')
    ap.add_argument('--bubaicode', help='bubaicode_tools_examples.jsonl 路径')
    ap.add_argument('--out', default='.')
    ap.add_argument('--val-ratio', type=float, default=0.02)
    args = ap.parse_args()

    samples = []
    lc_samples = []
    if args.bubaicode and os.path.exists(args.bubaicode):
        lc = load_jsonl(args.bubaicode)
        print('bubaicode 样本:', len(lc))
        lc_samples = lc
        samples += lc
    if args.hermes and os.path.exists(args.hermes):
        samples += hermes_to_samples(args.hermes)
    if not samples:
        print('没有输入数据；至少提供 --hermes 或 --bubaicode')
        return

    # bubaicode 样本复制 5 份提高权重（真实工具不能淹没在通用数据里）
    if lc_samples:
        samples += lc_samples * 5
        print('bubaicode 加权后总量:', len(samples))
    random.seed(42)
    random.shuffle(samples)
    n_val = max(1, int(len(samples) * args.val_ratio))
    val, train = samples[:n_val], samples[n_val:]

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'train.jsonl'), 'w', encoding='utf-8') as f:
        for s in train:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')
    with open(os.path.join(args.out, 'val.jsonl'), 'w', encoding='utf-8') as f:
        for s in val:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')
    print('train:', len(train), 'val:', len(val))
    print('示例目标:', json.dumps(train[0]['messages'][-1], ensure_ascii=False)[:200])


if __name__ == '__main__':
    main()
