# -*- coding: utf-8 -*-
"""run.bat 编码 / 换行 / 语法体检（只读，不修改）。"""
from __future__ import annotations

import re
from pathlib import Path

p = Path(__file__).resolve().parent.parent / "run.bat"
b = p.read_bytes()

print(f"[文件] {p.name}  {len(b)} bytes")

# 1. BOM
has_bom = b.startswith(b"\xef\xbb\xbf")
print(f"[1] BOM: {'有 !! cmd 会把 BOM 拼进第一条命令，直接启动失败' if has_bom else '无'}")

# 2. 换行
crlf = b.count(b"\r\n")
lf_only = b.count(b"\n") - crlf
print(f"[2] 换行: CRLF={crlf}  裸LF={lf_only}"
      + ("  !! 纯LF，goto/标签会失效" if crlf == 0 and lf_only > 0 else ""))

# 3. UTF-8 合法性
try:
    b.decode("utf-8")
    print("[3] UTF-8 解码: OK")
except UnicodeDecodeError as e:
    print(f"[3] UTF-8 解码: 失败 {e}")

# 4. 首行
first = b.split(b"\n", 1)[0]
print(f"[4] 首行字节: {first[:24]!r}")

# 5. 语法扫描（跳过 chcp 之后的中 文 echo 行）
try:
    text = b.decode("utf-8-sig")
except UnicodeDecodeError:
    text = b.decode("gbk", errors="replace")

bad = []
for n, line in enumerate(text.splitlines(), 1):
    s = line.strip()
    # 病灶： %errorlevel!=  缺收尾百分号
    if re.search(r"%errorlevel!(?!=)", s):
        bad.append((n, s, "%errorlevel! 缺少收尾 %"))
    if re.search(r"\bif\s+%errorlevel!\s*=", s):
        bad.append((n, s, "if %errorlevel!== 形式错误"))
    # 未闭合括号的行内 if
    if s.lower().startswith("if ") and s.count("(") != s.count(")"):
        bad.append((n, s, "括号不配对"))

if bad:
    print(f"[5] 语法问题 {len(bad)} 处:")
    for n, s, why in bad:
        print(f"    行{n}: {s[:52]!r}  ← {why}")
else:
    print("[5] 语法扫描: 未发现已知病灶")

# 6. 标签与 goto 对账
labels = {s[1:].lower() for s in text.splitlines()
          if s.strip().startswith(":") and not s.strip().startswith("::")}
gotos = {m.lower() for m in re.findall(r"\bgoto\s+:?(\w+)", text, re.I)}
missing = gotos - labels
print(f"[6] 标签: {sorted(labels)}")
if missing:
    print(f"    !! goto 目标缺失: {missing}")
else:
    print(f"    goto 目标全部可达")