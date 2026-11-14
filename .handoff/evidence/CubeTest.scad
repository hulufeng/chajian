// CubeTest — OpenSCAD 参数化模型（TrieCode 脚手架）
// 顶层常量 = 可调参数；改完用 plugin_openscad-toolchain_preview 看图，定稿用 render 导出 STL/3MF。
length = 40;   // 长度 (mm)
width  = 20;   // 宽度 (mm)
height = 10;   // 高度 (mm)
wall   = 2;    // 壁厚 (mm)

module box_body() {
  // 倒角/螺纹等高级原语可用内置 BOSL2：include <BOSL2/std.scad> 后 cuboid(size, chamfer=) 等
  cube([length, width, height], center = true);
}

// echo() 输出测量值（预览/渲染输出里可见，AI 自检用）
echo(str("dimensions: ", length, "x", width, "x", height, " mm"));

box_body();
