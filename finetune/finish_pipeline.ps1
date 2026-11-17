# ASCII-only on purpose (PowerShell parsing breaks on mixed-encoding files).
# Run AFTER train_win.py finished: merged HF model -> GGUF -> Q4_K_M -> eval vs baseline.
#
#   powershell -File finetune\finish_pipeline.ps1
#
# Notes:
#  - Conversion needs ~7GB RAM. Do NOT run it while training is running (it got killed before).
#  - llama-quantize.exe comes from the packaged BubaiCode (dist\win-unpacked\resources\llama).

param([string]$OutDir = 'out_win')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $root
$merged = Join-Path $root "$OutDir\merged"
$quant = Join-Path $repo 'desktop-app\dist\win-unpacked\resources\llama\llama-quantize.exe'
$outDir = 'D:\work\tmp'
$f16 = Join-Path $outDir 'tools3b_f16.gguf'
$q4 = Join-Path $outDir 'tools3b-Q4_K_M.gguf'
$baseline = 'C:\Users\Administrator\AppData\Roaming\codelab-desktop\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf'

if (-not (Test-Path $merged)) { Write-Host "MERGED_MISSING: $merged"; exit 1 }

Write-Host 'STEP 1/3 convert HF -> GGUF (f16)'
$env:NO_LOCAL_GGUF = '1'
$env:PYTHONIOENCODING = 'utf-8'
python -u (Join-Path $root 'convert_hf_to_gguf.py') $merged --outfile $f16 --outtype f16
if ($LASTEXITCODE -ne 0) { Write-Host "CONVERT_FAILED exit=$LASTEXITCODE"; exit 1 }
Write-Host "F16_BYTES: " + (Get-Item $f16).Length

Write-Host 'STEP 2/3 quantize -> Q4_K_M'
if (-not (Test-Path $quant)) { Write-Host "QUANTIZER_MISSING: $quant"; exit 1 }
& $quant $f16 $q4 Q4_K_M
if ($LASTEXITCODE -ne 0) { Write-Host "QUANTIZE_FAILED exit=$LASTEXITCODE"; exit 1 }
Write-Host "Q4_BYTES: " + (Get-Item $q4).Length

Write-Host 'STEP 3/3 eval: baseline vs tuned'
python -u (Join-Path $root 'eval_tools.py') --baseline $baseline --model $q4 --repeat 3
Write-Host "DONE_GGUF: $q4"
