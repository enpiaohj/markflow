// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLargeFileMb,
  getMaxEditMb,
  getMaxListRender,
  getOfficeEngine,
  getTheme,
  setEditorSizeLimits,
  setMaxListRender,
  setTheme,
} from "./prefs";

beforeEach(() => localStorage.clear());
afterEach(() => document.documentElement.classList.remove("dark"));

describe("偏好默认值与容错", () => {
  it("未设置时返回默认值", () => {
    expect(getTheme()).toBe("light");
    expect(getOfficeEngine()).toBe("builtin");
    expect(getLargeFileMb()).toBe(2);
    expect(getMaxEditMb()).toBe(50);
    expect(getMaxListRender()).toBe(2000);
  });

  it("存储值非法时回退默认值", () => {
    localStorage.setItem("mf-pref-theme", "neon");
    localStorage.setItem("mf-pref-editor-large-mb", "abc");
    localStorage.setItem("mf-pref-max-list-render", "-5");
    expect(getTheme()).toBe("light");
    expect(getLargeFileMb()).toBe(2);
    expect(getMaxListRender()).toBe(2000);
  });

  it("编辑器大小上限受硬上限约束，且最大编辑值不小于保护模式阈值", () => {
    localStorage.setItem("mf-pref-editor-max-mb", "9999");
    expect(getMaxEditMb()).toBe(256);
    setEditorSizeLimits(10, 5);
    expect(getLargeFileMb()).toBe(10);
    expect(getMaxEditMb()).toBe(10);
  });

  it("列表渲染上限可设为不限", () => {
    setMaxListRender(Infinity);
    expect(getMaxListRender()).toBe(Infinity);
    setMaxListRender(500);
    expect(getMaxListRender()).toBe(500);
  });
});

describe("主题", () => {
  it("dark 给 <html> 加 dark 类，切回 light 去掉", () => {
    setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
