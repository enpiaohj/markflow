import { describe, expect, it } from "vitest";
import { ellipsizePath, formatSize, formatTime, officeKind, openRouteFor } from "./format";

describe("formatSize", () => {
  it("按 1024 进位并保留合理精度", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(100 * 1024)).toBe("100 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("formatTime", () => {
  it("0 显示为破折号，其余为本地 年/月/日 时:分", () => {
    expect(formatTime(0)).toBe("—");
    expect(formatTime(new Date(2026, 8, 5, 7, 3).getTime())).toBe("2026/09/05 07:03");
  });
});

describe("openRouteFor", () => {
  it("按格式分流到内置查看器 / 编辑器 / 系统应用", () => {
    expect(openRouteFor("pdf")).toBe("pdf");
    expect(openRouteFor("word")).toBe("office");
    expect(openRouteFor("excel")).toBe("office");
    expect(openRouteFor("powerpoint")).toBe("office");
    expect(openRouteFor("image")).toBe("image");
    for (const f of ["markdown", "text", "code", "html", "json", "yaml", "xml", "config", "csv"]) {
      expect(openRouteFor(f)).toBe("editor");
    }
    expect(openRouteFor("archive")).toBe("system");
    expect(openRouteFor("other")).toBe("system");
  });
});

describe("officeKind", () => {
  it("识别 Office / WPS / ODF 扩展名，忽略大小写", () => {
    expect(officeKind("报告.DOCX")).toBe("word");
    expect(officeKind("a.rtf")).toBe("word");
    expect(officeKind("表.xls")).toBe("excel");
    expect(officeKind("表.ods")).toBe("excel");
    expect(officeKind("演示.pptx")).toBe("powerpoint");
    expect(officeKind("a.txt")).toBeNull();
    expect(officeKind("noext")).toBeNull();
  });
});

describe("ellipsizePath", () => {
  it("短路径原样返回", () => {
    expect(ellipsizePath(String.raw`D:\库\a.md`)).toBe(String.raw`D:\库\a.md`);
  });
  it("长路径保留首段与末尾几段，中间用省略号", () => {
    const p = String.raw`D:\CCProjects\Projects\Haier\2601-AD-Upgrade-0916\01-项目计划\方案.docx`;
    const out = ellipsizePath(p, 40);
    expect(out.startsWith(String.raw`D:\…` + "\\")).toBe(true);
    expect(out.endsWith("方案.docx")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out).not.toContain("Projects");
  });
  it("超长文件名也做中间省略，不整体撑破", () => {
    const out = ellipsizePath(String.raw`D:\a\b` + "\\" + "很长的文件名".repeat(10) + ".pdf", 40);
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out).toContain("…");
  });
  it("支持 / 分隔的路径", () => {
    const out = ellipsizePath("C:/Users/sadmin/AppData/Local/Temp/claude/very/deep/folder/file.txt", 30);
    expect(out.startsWith("C:/…/")).toBe(true);
    expect(out.endsWith("file.txt")).toBe(true);
  });
});
