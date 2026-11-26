# 图标来源

插件图标不是画出来的，是从游点灵官网 favicon 轮廓追踪来的。

```
favicon.ico ──提取──> logo256.png ──trace.py──> path_0.7.txt ──build-icon.py──> assets/icon.svg
                                                                              └─> lib/icon.mjs
```

改图形就重跑这条链，别手改 `lib/icon.mjs` 里的坐标。

## 怎么跑

```sh
cd .logosrc
python trace.py logo256.png 0.7 0.7 > traced.txt   # 位图轮廓 → 紧凑路径
python build-icon.py                                # 生成 assets/icon.svg 与 data URI
```

`trace.py` 的第三、四个参数是抽稀容差（像素）。0.7 是实测的平衡点：再小文件变大但看不出区别，再大圆角开始出棱角。

## 图形结构

紫色圆角方块，中间白色四角星，右下角斜切口。**星形不是独立填充层**——它从右下切口一路连通到外部，所以整块紫色是单连通区域，一条闭合路径就够。主色 `#A956FF` 采样自 favicon 像素。
