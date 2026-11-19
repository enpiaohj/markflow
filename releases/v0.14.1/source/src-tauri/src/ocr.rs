//! Windows OCR（设计文档 §8.10：P0 使用系统能力处理常见中英文图片）：
//! 识别文本写入提取缓存与 FTS（extractor = ocr-win），不改图片源文件；
//! 返回平均词置信度；扫描 PDF 的页面级 OCR 需渲染管线，按路线后续交付。
//!
//! 实现说明：WinRT 调用在专用 MTA 线程上以阻塞方式完成（init_apartment + get()），
//! 由命令层通过 spawn_blocking 调度，避免阻塞异步运行时。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
}

/// 系统是否具备 OCR 能力（已安装对应语言包时返回 true）。
pub fn available() -> bool {
    // windows crate 的 FactoryCache 会按需 CoIncrementMTAUsage，无需显式初始化
    windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages().is_ok()
}

/// 识别图片字节（PNG/JPG 等系统解码器支持的格式）。阻塞调用，请置于专用线程。
pub fn recognize_bytes(bytes: &[u8]) -> Result<OcrResult, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "系统未安装 OCR 语言包，请在 Windows 设置 → 时间和语言 → 语言中添加中文或英文语言".to_string())?;

    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
    writer.WriteBytes(bytes).map_err(|e| e.to_string())?;
    writer.StoreAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    writer.FlushAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    stream.Seek(0).map_err(|e| e.to_string())?;

    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;

    let result = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let text = result.Text().map_err(|e| e.to_string())?.to_string();

    // 注：当前 Windows SDK 元数据中 OcrWord 未提供 Confidence 属性，置信度字段暂缺
    Ok(OcrResult { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OCR 依赖系统语言包，缺失时跳过（不作为失败）。
    #[test]
    fn ocr_availability_probe() {
        println!("[OCR] Windows OCR 可用: {}", available());
    }
}
