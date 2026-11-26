"""从追踪好的轮廓生成插件用的图标资源。

输出两样东西：
  assets/icon.svg        —— 独立文件，方便直接看
  icon-data-uri.txt      —— base64，贴进 registry-entry.json 的 icon 字段

几何来自官网 favicon（256×256）的轮廓追踪，不是手画的近似图形。
坐标已换算到 64×64 视框，圆角与星形尖角都保留原样。
"""

import base64
import io
import re

COLOR = '#A956FF'  # 从 favicon 采样得到的主色

path = io.open('path_0.7.txt', encoding='utf-8').read().strip()

svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
    f'<path d="{path}" fill="{COLOR}"/>'
    '</svg>'
)

io.open('../assets/icon.svg', 'w', encoding='utf-8', newline='\n').write(svg + '\n')
print('svg 字节:', len(svg))

# 插件要求是 data URI，用 base64 包一层
b64 = base64.b64encode(svg.encode('utf-8')).decode('ascii')
uri = 'data:image/svg+xml;base64,' + b64
io.open('icon-data-uri.txt', 'w', encoding='utf-8').write(uri)
print('data URI 长度:', len(uri))
print('前缀:', uri[:60], '...')
