# BubaiCode 本地模型「工具决策专家」微调套件

目标：把 Qwen2.5-Coder-7B（本地 GGUF）微调成**会选工具、会填参数**的决策模型，治「笨」的本。
与线上 GBNF 约束解码（`desktop-app/main/index.js` 的 `buildToolGbnf`）配合：约束保格式，微调保选择质量。

## 实测基线（2026-10-22，本机 RTX 5060 Ti / eval_tools.py x3）

| 模型 | 工具决策准确率 |
|---|---|
| qwen2.5-coder-**3B**-instruct Q4_K_M | **31.0%**（13/42） |
| qwen2.5-coder-**7B**-instruct Q4_K_M | **66.7%**（28/42） |

7B 的典型错法：`edit_file("串口波特率从9600改成115200")` 判错、`run_test("编译一下看看有没有报错")` 判错、
`none("I2C 和 SPI 有什么区别")` 误触发工具 —— 正是本套件要治的「选择质量」问题。

## 工作流 A：Windows 原生（本机路线，推荐）

本机没有 WSL（`wsl` 命令不存在），Unsloth 依赖 triton、官方只支持 Linux/WSL，**跑不起来**。
所以走 transformers + peft 的原生 LoRA/QLoRA。

```bat
:: 0) 环境（已实测：torch 2.7.1+cu128 / transformers 4.52.4 / peft 0.21.2 / bitsandbytes 0.50.2）
pip install --index-url https://download.pytorch.org/whl/cu128 torch==2.7.1+cu128
pip install transformers==4.52.4 peft accelerate datasets bitsandbytes

:: 1) 基座模型（HF 直连被封，走 hf-mirror）
set HF_ENDPOINT=https://hf-mirror.com
python -c "from huggingface_hub import snapshot_download; print(snapshot_download('Qwen/Qwen2.5-Coder-3B-Instruct'))"

:: 2) 数据准备（Hermes 多轮 -> 决策 JSON；bubaicode 真实样本 5 倍加权）
python prepare_data.py --hermes func-calling.json --bubaicode bubaicode_tools_examples.jsonl --out .

:: 3) 训练（先 dry-run 看数据管线）
python train_win.py --base Qwen/Qwen2.5-Coder-3B-Instruct --dry-run
python train_win.py --base Qwen/Qwen2.5-Coder-3B-Instruct --epochs 3 --bs 1 --accum 8
::    8GB 显存跑 7B：加 --load-4bit（bitsandbytes NF4）
::    产出 out_win/lora（适配器）+ out_win/merged（合并后的 HF 模型）

:: 4) 验收（GBNF 取自上线代码 main/index.js，由 node 求值生成）
python eval_tools.py --model <微调后GGUF> --repeat 3
python eval_tools.py --baseline <原GGUF> --model <微调后GGUF> --repeat 3
```

待解决：HF → GGUF 转换需要 llama.cpp 的 `convert_hf_to_gguf.py`，
github raw 在本机被 RST（WinError 10054），目前只能离线拷贝该脚本或用其它通道获取。

## 工作流 B：Linux / WSL（Unsloth，更快但本机不可用）

```bash
# 0) 环境（Python 3.10+，NVIDIA 8GB+）
pip install "unsloth @ git+https://github.com/unslothai/unsloth.git"
pip install --no-deps "trl==0.11.4" peft accelerate transformers datasets

# 1) 下载开源工具调用数据（国内用 hf-mirror）
#    hermes-function-calling-v1（开放无 gated，56k 下载）
curl -L -o func-calling.json https://hf-mirror.com/datasets/NousResearch/hermes-function-calling-v1/resolve/main/func-calling.json

# 2) 数据准备：Hermes 多轮对话 -> 决策 JSON（与 GBNF 形状一致）；bubaicode 真实工具样本自动加权 5 份
python prepare_data.py --hermes func-calling.json --bubaicode bubaicode_tools_examples.jsonl --out .

# 3) 训练（RTX 5060 Ti 8GB 约 1-2 小时）
python train_unsloth.py --data . --out lora_out
#    产出 lora_out/（adapter）+ lora_out/gguf/（可直接用的 GGUF）

# 4) 验收：训练前/后对比（同一 GBNF + 同一套题，14 类用例 x N 次）
python eval_tools.py --baseline "D:\BubaiCode\models\qwen2.5-coder-7b-instruct-q4_k_m.gguf" ^
                     --model   "lora_out\gguf\qwen2.5-coder-7b-tools-Q4_K_M.gguf" --repeat 3
```

## 文件

| 文件 | 作用 |
|---|---|
| `bubaicode_tools_examples.jsonl` | 22 条 BubaiCode 真实工具场景（读/写/改/编译/搜索/装插件 + 多轮循环 + none） |
| `prepare_data.py` | ShareGPT → 决策 JSON；自动抽取每个工具调用轮作为训练目标，带完整上文 |
| `train_unsloth.py` | Unsloth QLoRA（r16, 4bit, seq4096）；合并 + 导出 GGUF（Linux/WSL） |
| `train_win.py` | **Windows 原生** LoRA/QLoRA（transformers+peft）；`--load-4bit` 走 bnb NF4；输出 lora + merged |
| `eval_tools.py` | 启动 llama-server 跑 14 类工具决策题，输出准确率；grammar 由 **node 执行上线 `buildToolGbnf`** 生成，支持基线对比 |

## 踩坑：第一轮训完塌缩成「永远 none」

现象：3 epoch 训完（train_loss 0.127），转 Q4_K_M 后验收 —— **工具调用类全部 0/3，none 类全部 3/3**，
准确率 31% → 28.6%，比不微调还差。

排查：先把转出的 GGUF 用 llama-server **无约束**跑一句中文问答，回答通顺 → GGUF/tokenizer 没问题，
锅在训练数据。

根因：**训练分布与线上候选集不匹配**。Hermes 原始数据里 200+ 种工具名（`buy_bitcoin`、`mintNFT`、
`search_hotels`…），而线上 GBNF 只认 BubaiCode 的 9 个名字。模型学到的「该调工具」在线上全部非法，
唯一恒合法又高频的退路是 `none`（占 40%）→ 塌缩。

所以**不要直接拿通用工具调用数据微调** —— 必须先用 `remap_to_bubaicode.py` 把工具名映射回线上那 9 个：

```bat
python remap_to_bubaicode.py --src train.jsonl --bubaicode bubaicode_tools_examples.jsonl --out .
::  -> train2.jsonl / val2.jsonl（工具名全在 GBNF 候选内，none 下采样到 25%，bubaicode 样本 x10）
python train_win.py --base <3B> --train train2.jsonl --val val2.jsonl --out out_win2 --epochs 2
```

## 设计要点

1. **训练形状 = 线上形状**：assistant 目标就是 `{"tool":..., "arguments":{...}}`，与 GBNF 约束逐字节一致，训完直接受益，不丢分在格式上。
2. **多轮上下文**：从 Hermes 多轮对话抽取「工具结果已回填」的样本（读→改→编译循环），教模型** Sequencing**，不是单发预测。
3. **none 也是正类**：闲聊/解释类必须学会不调用工具（线上 grammar 里 none 是首选退路，选错=浪费一轮）。
4. **bubaicode 样本 5 倍加权**：防止真实工具名被通用数据淹没。
5. **只训 assistant 决策轮**（prompt/completion 截取差集），system+user 上下文不算 loss。

## 预期效果

基线（未微调 7B）在本套题约 60-80%；微调后目标 ≥95%（选择质量），配合 GBNF 后格式 100%。
验收不过线（<90%）就调数据：加 bubaicode 样本、降 hermes 占比、或加训一轮。

## 后续可选

- 数据扩充：`THUDM/AgentInstruct`（智能体轨迹，hf-mirror 可下）、ToolACE（HF 数据集）
- 换基座：Qwen3-8B-Instruct（混合思考，工具调用更强；8GB 卡 Q4 可行）
- 进阶：DPO/GRPO 用「线上真实失败案例」做偏好优化（把 AgentRunner 里 noProgressRounds 触发的失败对话导出成训练数据）
