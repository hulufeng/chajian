修：共用 VID:PID 的板在界面上被当成"已认准"（补 UI 这一半）

上一 commit（95159b0）只把候选摊给了主进程和 Agent，`target:detect` 的 `candidateIds`
没人消费 —— 结果插 ESP32-C3 时端口下拉照样把 `targetName`（= S3）显示得跟认准了一样，
用户看不出该选哪块板。这半截必须补上，否则主进程加了字段等于没加。

- `preload/index.ts` 的 `DetectedPort` 补 `candidateIds?: string[]`（带注释说明 >1 的含义），
  渲染层类型才跟得上主进程新吐的字段。
- `TargetPanel` 端口下拉：候选 > 1 时 option 文案追加「· 同 VID:PID 多板，请选准板卡」，
  选中该端口后在下方挂一条 `tgt-note tgt-warn` 提示「该 VID:PID 对应 N 块板（列表），
  硬件上区分不了，请在上方板卡里按型号选准」。
  用现成的 `.tgt-note` / `.tgt-warn`（都是令牌色），没新增 hex。

验证：tsc web / tsc node 均 0；`node scripts/check-board-registry.mjs` 33 项全过；
electron-vite build 通过；pkgout23 打包 BUILDER_EXIT=0 + check-ui-assets 三页 ✓
（该包含上一 commit 的主进程修复）。
