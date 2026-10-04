<!--
id: buzzer-music
keywords: 蜂鸣器音乐,音调,旋律,note,频率,ledcwritetone,播放音乐,buzzer tone,歌曲
-->
### 蜂鸣器播放音乐
无源蜂鸣器用不同频率驱动可发出音符（有源蜂鸣器只能响/停，不能奏曲）。用 `ledcWriteTone` 按频率发声：
```cpp
#define BUZZ 15
// 音符频率(Hz): C4=262 D4=294 E4=330 F4=349 G4=392 A4=440 B4=494 C5=523
const int notes[] = {262,262,392,392,440,440,392,349,349,330,330,294,294,262};
const int beats[] = {1,1,1,1,1,1,2,1,1,1,1,1,1,2};
void setup() { ledcAttach(BUZZ,2000,8); }
void loop() {
  for (int i=0;i<14;i++) {
    ledcWriteTone(BUZZ, notes[i]); delay(280*beats[i]);
    ledcWrite(BUZZ,0); delay(30); // 音符间断
  }
  delay(2000);
}
```
要点：无源蜂鸣器才能变调；上面是《小星星》；新版 API 用 `ledcAttach(pin,freq,resolution)` + `ledcWriteTone`，旧版 `ledcSetup/ledcAttachPin`；蜂鸣器不要长时间满占，注意音量与供电。
