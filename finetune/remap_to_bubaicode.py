#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
remap_to_bubaicode.py - 把训练数据的工具名映射回 BubaiCode 线上那 9 个工具

为什么要这一步（踩过的坑）：
第一轮直接用 Hermes 原始数据训，结果模型在 GBNF 约束下**塌缩成永远输出 none**。
根因是 Hermes 里有 200+ 种工具名（buy_bitcoin / mintNFT / search_hotels …），
而线上 GBNF 只允许 BubaiCode 的 9 个名字 —— 训练分布与线上候选集完全不匹配，
模型学到的"该调工具"映射到线上就是一堆非法名字，退而求其次只能选 none。

修法：
  1. 工具名按语义映射到 BubaiCode 的 9 个（映射不了的样本直接丢）
  2. none 类下采样（闲聊/解释类），避免模型偷懒
  3. bubaicode 手写样本按权重复制（真实场景优先）

用法：
  python remap_to_bubaicode.py --src train.jsonl --bubaicode bubaicode_tools_examples.jsonl --out .
  # 产出 train2.jsonl / val2.jsonl
"""
import argparse
import json
import os
import random
import re

BUBAI_TOOLS = ['read_file', 'write_file', 'edit_file', 'terminal', 'run_test',
                 'list_files', 'search_files', 'create_project', 'install_plugin']

# 关键词 -> BubaiCode 工具（按顺序匹配，越靠前优先级越高）
RULES = [
    (r'(run[_-]?test|unit[_-]?test|pytest|compile[_-]?test|do[_-]?test|test[_-]?suite)', 'run_test'),
    (r'(test|verify|validate|check|debug|diagnose)', 'run_test'),
    (r'(read[_-]?file|get[_-]?file|fetch[_-]?file|open[_-]?file|load[_-]?file|view[_-]?file|'
     r'read|get[_-]?content|get[_-]?document|retrieve|download|fetch|show[_-]?file|cat[_-]?file)', 'read_file'),
    (r'(write[_-]?file|create[_-]?file|save[_-]?file|new[_-]?file|make[_-]?file|put[_-]?file|'
     r'write|draft|compose|generate[_-]?file|upload[_-]?file)', 'write_file'),
    (r'(edit[_-]?file|modify|update|patch|replace|revise|change|set[_-]?|edit)', 'edit_file'),
    (r'(create[_-]?project|init[_-]?project|new[_-]?project|scaffold|setup[_-]?project|'
     r'create[_-]?repo|init[_-]?repo)', 'create_project'),
    (r'(install[_-]?plugin|add[_-]?plugin|plugin|extension|addon)', 'install_plugin'),
    (r'(search[_-]?file|find[_-]?file|grep|search|find|lookup|locate|query)', 'search_files'),
    (r'(list[_-]?file|list[_-]?dir|list|enumerate|browse|show[_-]?files|get[_-]?files|'
     r'inventory|dir)', 'list_files'),
    (r'(terminal|shell|execute|run[_-]?command|command|bash|cmd|compile|build|deploy|'
     r'install[_-]?package|git|start|launch|clone|push|commit)', 'terminal'),
]


def map_tool(name):
    n = (name or '').strip()
    if n in BUBAI_TOOLS:
        return n
    if n == 'none':
        return 'none'
    low = n.lower()
    for pat, target in RULES:
        if re.search(pat, low):
            return target
    return None


def last_assistant_decision(messages):
    """返回 (index, dict)：最后一条 assistant 的决策 JSON"""
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get('role') != 'assistant':
            continue
        try:
            d = json.loads(m.get('content', ''))
        except Exception:
            return None
        if isinstance(d, dict) and 'tool' in d:
            return i, d
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='train.jsonl')
    ap.add_argument('--bubaicode', default='bubaicode_tools_examples.jsonl')
    ap.add_argument('--out', default='.')
    ap.add_argument('--none-ratio', type=float, default=0.25, help='none 样本占比上限')
    ap.add_argument('--bubaicode-weight', type=int, default=10, help='bubaicode 手写样本复制份数')
    ap.add_argument('--val-ratio', type=float, default=0.03)
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()
    random.seed(args.seed)

    def load(p):
        rows = []
        if os.path.exists(p):
            for line in open(p, encoding='utf-8'):
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    src_rows = load(args.src)
    lc_rows = load(args.bubaicode)

    kept, dropped, remapped = [], 0, 0
    for r in src_rows:
        hit = last_assistant_decision(r['messages'])
        if not hit:
            dropped += 1
            continue
        i, d = hit
        old = d.get('tool')
        new = map_tool(old)
        if new is None:
            dropped += 1
            continue
        if new != old:
            remapped += 1
            d['tool'] = new
            r['messages'][i]['content'] = json.dumps(d, ensure_ascii=False)
        kept.append(r)

    print(f'输入 {len(src_rows)} 条：保留 {len(kept)}，丢弃 {dropped}（工具名无法映射），改名 {remapped}')

    tool_rows, none_rows = [], []
    for r in kept:
        t = last_assistant_decision(r['messages'])[1].get('tool')
        (none_rows if t == 'none' else tool_rows).append(r)
    print(f'  工具调用 {len(tool_rows)} / none {len(none_rows)}')

    # none 下采样
    max_none = int(len(tool_rows) * args.none_ratio / max(1e-9, (1 - args.none_ratio)))
    if len(none_rows) > max_none:
        random.shuffle(none_rows)
        none_rows = none_rows[:max_none]
        print(f'  none 下采样到 {len(none_rows)}')

    samples = tool_rows + none_rows
    samples += lc_rows * args.bubaicode_weight

    random.shuffle(samples)
    n_val = max(1, int(len(samples) * args.val_ratio))
    val, train = samples[:n_val], samples[n_val:]

    out_dir = args.out
    with open(os.path.join(out_dir, 'train2.jsonl'), 'w', encoding='utf-8') as f:
        for s in train:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')
    with open(os.path.join(out_dir, 'val2.jsonl'), 'w', encoding='utf-8') as f:
        for s in val:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    import collections
    c = collections.Counter()
    for s in train:
        hit = last_assistant_decision(s['messages'])
        if hit:
            c[hit[1].get('tool')] += 1
    print(f'产出 train2={len(train)} val2={len(val)}')
    print('最终工具分布:', dict(c.most_common()))


if __name__ == '__main__':
    main()
