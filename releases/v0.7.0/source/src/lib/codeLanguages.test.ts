import { describe, expect, it } from "vitest";
import { detectIndent, detectLanguage, languageById } from "./codeLanguages";

describe("detectLanguage：文件名 → 扩展名 → Shebang → 纯文本", () => {
  it("按扩展名识别（含中文路径、大小写）", () => {
    expect(detectLanguage("文档库/部署 脚本/安装.PS1").id).toBe("powershell");
    expect(detectLanguage("a/b/Program.cs").id).toBe("csharp");
    expect(detectLanguage("x.tsx").id).toBe("typescript");
    expect(detectLanguage("x.jsx").id).toBe("javascript");
    expect(detectLanguage("app.config.yml").id).toBe("yaml");
    expect(detectLanguage("query.sql").id).toBe("sql");
    expect(detectLanguage("settings.jsonc").id).toBe("jsonc");
    expect(detectLanguage("build.csproj").id).toBe("xml");
    expect(detectLanguage("说明.md").id).toBe("markdown");
  });

  it("按文件名识别无扩展名 / 隐藏文件", () => {
    expect(detectLanguage("Dockerfile").id).toBe("dockerfile");
    expect(detectLanguage("sub/dockerfile").id).toBe("dockerfile");
    expect(detectLanguage(".env").id).toBe("ini");
    expect(detectLanguage(".gitignore").id).toBe("ini");
    expect(detectLanguage(".bashrc").id).toBe("shell");
  });

  it("无扩展名时用 Shebang", () => {
    expect(detectLanguage("run", "#!/usr/bin/env python3").id).toBe("python");
    expect(detectLanguage("run", "#!/bin/bash").id).toBe("shell");
    expect(detectLanguage("run", "#!/usr/bin/env node").id).toBe("javascript");
    expect(detectLanguage("run", "#!/usr/bin/env pwsh").id).toBe("powershell");
  });

  it("扩展名优先于 Shebang；未知降级为纯文本", () => {
    expect(detectLanguage("tool.py", "#!/bin/bash").id).toBe("python");
    expect(detectLanguage("无扩展名").id).toBe("text");
    expect(detectLanguage("notes.unknownext").id).toBe("text");
    expect(languageById("不存在").id).toBe("text");
  });
});

describe("detectIndent", () => {
  it("识别制表符", () => {
    expect(detectIndent("a\n\tb\n\t\tc\n\td\n")).toEqual({ kind: "tab", width: 4 });
  });
  it("识别 2 / 4 空格", () => {
    expect(detectIndent("a:\n  b:\n    c: 1\n  d: 2\n")).toEqual({ kind: "space", width: 2 });
    expect(detectIndent("def f():\n    x = 1\n    if x:\n        y = 2\n")).toEqual({ kind: "space", width: 4 });
  });
  it("无缩进时默认 4 空格", () => {
    expect(detectIndent("a\nb\n")).toEqual({ kind: "space", width: 4 });
  });
});
