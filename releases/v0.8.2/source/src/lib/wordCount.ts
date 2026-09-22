/** 字数统计：中日韩文字逐字计，其余按「连续的字母数字」计词（与常见字处理软件的口径接近）。 */
export function countText(text: string): { chars: number; words: number; total: number } {
  const noSpace = text.replace(/\s+/g, "");
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) ?? []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, " ").match(/[A-Za-z0-9_]+/g) ?? []).length;
  return { chars: noSpace.length, words: latin, total: cjk + latin };
}
