<!--
id: cpu-power-tune
keywords: 降频,cpu频率,功耗优化,省电,setcpufrequency,性能优化,低功耗,240mhz,80mhz
-->
### CPU 频率与功耗优化
降低 CPU 频率可显著省电（电池设备），对算力要求不高时降频：
```cpp
setCpuFrequencyMhz(80); // 默认240，可选240/160/80
```
省电组合拳：不用时关 Wi-Fi/蓝牙（`WiFi.mode(WIFI_OFF)`、`btStop()`）、用 Light/Deep sleep、降低频率、减少 flash 写入、批量发送数据以缩短射频开启时间。
性能：中断高频处理函数加 `IRAM_ATTR` 放内部 RAM 执行更快；大数据搬运用 DMA 解放 CPU；避免在中断里做重活；`ledc`/定时器等外设计算不占 CPU。
要点：降频会影响串口/外设时序和响应速度，按实际测；省电优先从占空比（睡眠）入手，收益远大于单纯降频。
