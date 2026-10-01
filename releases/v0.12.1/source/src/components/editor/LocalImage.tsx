import Image, { type ImageOptions } from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";

/** 把 Markdown 里的图片地址解析成 WebView 能显示的 URL（库内相对路径 → 读字节生成 blob URL）。 */
export type ImageResolver = (src: string) => Promise<string>;

function ImageView({ node, extension, selected }: NodeViewProps) {
  const src = (node.attrs.src as string) ?? "";
  const alt = (node.attrs.alt as string) ?? "";
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const resolve = (extension.options as { resolve?: ImageResolver }).resolve;
    if (!resolve) {
      setUrl(src);
      return;
    }
    resolve(src)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [src, extension]);

  return (
    <NodeViewWrapper as="span" className="inline-block max-w-full align-bottom">
      {failed ? (
        <span className="inline-flex items-center gap-1 rounded border border-dashed border-red-300 bg-red-50 px-2 py-1 text-xs text-red-600" title={src}>
          图片无法加载：{src}
        </span>
      ) : (
        <img
          src={url}
          alt={alt}
          draggable={false}
          className={`max-w-full rounded ${selected ? "ring-2 ring-primary-500" : ""}`}
        />
      )}
    </NodeViewWrapper>
  );
}

/** 带库内相对路径解析的图片节点：Markdown 里仍是相对路径，只在编辑器里显示时才转成 blob URL。 */
export const LocalImage = Image.extend<ImageOptions & { resolve?: ImageResolver }>({
  addOptions() {
    return { ...(this.parent?.() as ImageOptions), resolve: undefined };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** 相对文档目录解析并规整路径（处理 `./`、`../`、%20）。越出库根返回 null。 */
export function resolveLibraryPath(docDir: string, src: string): string | null {
  let clean = src.split("#")[0].split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* 保持原样 */
  }
  const parts = (clean.startsWith("/") ? clean.slice(1) : docDir ? `${docDir}/${clean}` : clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

const blobCache = new Map<string, string>();

/** 创建解析器：外链 / data / blob 原样返回，库内路径读字节生成 blob URL（带缓存）。 */
export function makeImageResolver(
  libraryId: string,
  docDir: string,
  readBytes: (libraryId: string, path: string) => Promise<ArrayBuffer>,
): ImageResolver {
  return async (src) => {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const path = resolveLibraryPath(docDir, src);
    if (!path) throw new Error("图片路径越出文档库");
    const key = `${libraryId}:${path}`;
    const hit = blobCache.get(key);
    if (hit) return hit;
    const bytes = await readBytes(libraryId, path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
    blobCache.set(key, url);
    return url;
  };
}
