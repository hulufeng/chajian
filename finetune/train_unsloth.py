#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
train_unsloth.py - 用 Unsloth 微调 Qwen2.5-Coder-7B 成为「工具决策专家」

产出：LoRA adapter（lora_out/）+ 合并后的 GGUF（gguf_out/）直接丢进 D:\\BubaiCode\\models 即可用。

硬件预期：RTX 5060 Ti 8GB 可跑（4bit + LoRA r16 + seq 4096），7B 全量数据约 1-2 小时。

前置：
  pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
  pip install --no-deps trl peft accelerate transformers datasets

用法：
  python train_unsloth.py --data . --out lora_out
  环境变量可覆盖：BASE_MODEL / EPOCHS / LR / RUN_NAME
"""
import argparse
import json
import os


def build_dataset(tokenizer, data_dir):
    """读 train.jsonl -> (prompt_text, completion_text) 对；只训练 assistant 决策轮"""
    from datasets import Dataset

    rows = []
    for split in ('train', 'val'):
        path = os.path.join(data_dir, f'{split}.jsonl')
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf-8'):
            rows.append(json.loads(line))
    if not rows:
        raise SystemExit('未找到 train.jsonl / val.jsonl，先跑 prepare_data.py')

    def to_text(example):
        msgs = example['messages']
        # 末条 assistant 为目标；用 chat template 分别渲染上文与全量，截取差集即 completion
        prompt_msgs = msgs[:-1]
        full = tokenizer.apply_chat_template(msgs, tokenize=False)
        prompt = tokenizer.apply_chat_template(
            prompt_msgs, tokenize=False, add_generation_prompt=True)
        assert full.startswith(prompt), '模板渲染异常：full 不是 prompt 的前缀'
        return {'prompt': prompt, 'completion': full[len(prompt):]}

    ds = Dataset.from_list(rows)
    ds = ds.map(to_text, remove_columns=ds.column_names)
    return ds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='.', help='prepare_data.py 输出目录')
    ap.add_argument('--out', default='lora_out')
    ap.add_argument('--base', default=os.environ.get(
        'BASE_MODEL', 'unsloth/qwen2.5-coder-7b-instruct-bnb-4bit'))
    ap.add_argument('--epochs', type=float, default=float(os.environ.get('EPOCHS', '2')))
    ap.add_argument('--lr', type=float, default=float(os.environ.get('LR', '2e-4')))
    ap.add_argument('--seq-len', type=int, default=4096)
    args = ap.parse_args()

    from unsloth import FastLanguageModel
    from trl import SFTConfig, SFTTrainer

    print('加载基座:', args.base)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.seq_len,
        load_in_4bit=True,
        dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0.0,
        bias='none',
        use_gradient_checkpointing='unsloth',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj',
                        'gate_proj', 'up_proj', 'down_proj'],
        random_state=42,
    )

    ds = build_dataset(tokenizer, args.data)
    print('训练样本:', len(ds), '示例 completion:', ds[0]['completion'][:120])

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        dataset_text_field=None,
        max_seq_length=args.seq_len,
        packing=False,
        args=SFTConfig(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            logging_steps=10,
            optim='adamw_8bit',
            weight_decay=0.01,
            lr_scheduler_type='cosine',
            seed=42,
            output_dir=args.out,
            report_to='none',
        ),
    )
    trainer.train()

    # 1) 存 LoRA adapter
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print('LoRA 已存:', args.out)

    # 2) 合并 + 导出 GGUF（llama.cpp 可直接加载；命名带日期便于管理）
    merged_dir = args.out + '_merged'
    model.save_pretrained_merged(merged_dir, tokenizer)
    gguf_dir = os.path.join(args.out, 'gguf')
    model.save_pretrained_gguf(gguf_dir, tokenizer)
    print('GGUF 已导出:', gguf_dir)
    print('下一步：把 GGUF 拷到 D:\\BubaiCode\\models，然后跑 eval_tools.py 验收')


if __name__ == '__main__':
    main()
