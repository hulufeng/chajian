fix(partition): 修分区表 tablePos 调试地址在魔数非缓冲开头时算错

自检打法继续推进到 partitionTable.ts（自研 ESP32 分区表/NVS 解析核心）。

- partitionTable.ts
  - parsePartitionTable 新增 baseAddr 形参，tablePos 用 baseAddr+off 而非固定
    PARTITION_TABLE_ADDR+off，魔数不在缓冲开头时调试地址才准。
  - readPartitionTable 切出 partition table slice 后，把 locatePartitionTable
    找到的偏移折算进 baseAddr（tableAddr+rel），闭环上一轮发现的真 bug。

- scripts/check-partition-table.mjs（新增，19 项全过）
  真实二进制夹具（魔数 0x50 0x69 + 32B 表项 + 结束标记 / NVS 命名空间+标量+string+blob+擦除区），
  覆盖 parsePartitionTable（默认与折算 baseAddr）、locatePartitionTable、parseNvs、
  以及用假 RawReader 的 readPartitionTable（直接回归 tablePos 折算）。

验证：tsc node/web 双过、electron-vite build 成功、fix 已进 out/main/index.js 产物。
