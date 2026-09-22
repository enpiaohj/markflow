//! 系统（资源管理器）文件图标：按扩展名从 Windows Shell 取标准图标，编码为 PNG data URL。
//!
//! - 与资源管理器显示一致：取的是系统图像列表里的图标，含 Office / Edge / Python 等已装软件注册的图标；
//! - 按**扩展名**取（不是按格式分类）：`.ts` 与 `.py` 同属「代码」但图标不同，`.jpg` 与 `.png` 也可能不同；
//! - 进程内调用 Win32（`SHGetFileInfoW` + `SHGFI_USEFILEATTRIBUTES`），不创建探测文件、不启动子进程；
//! - 取系统「超大图标」列表（48px），在 24 / 32px 显示位置于 100%–150% 缩放下都清晰；
//! - 图标资源不随应用分发，全部来自用户本机；提取失败的扩展名前端回退内置图标。

use crate::lockext::LockExt;
use std::collections::HashMap;
use std::sync::Mutex;

/// 文件夹图标使用的特殊键（真实扩展名不会以 `<` 开头）
pub const FOLDER_KEY: &str = "<folder>";

/// 扩展名（小写、不含点；无扩展名为空串）→ data URL；`None` 表示已尝试但系统没有可用图标
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// 单次请求最多处理的扩展名数（防御前端异常请求）
const MAX_BATCH: usize = 256;

/// 规范化扩展名键：小写、去掉前导点；只允许常见文件名字符，其余视为无效
fn normalize(key: &str) -> Option<String> {
    if key == FOLDER_KEY {
        return Some(key.to_string());
    }
    let k = key.trim().trim_start_matches('.').to_lowercase();
    if k.len() > 32 || !k.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '+' | '~')) {
        return None;
    }
    Some(k)
}

/// 取一批扩展名的图标；已缓存的直接返回，未缓存的在专用 STA 线程中提取后写入缓存。
pub fn icons_for(keys: Vec<String>) -> HashMap<String, String> {
    let wanted: Vec<String> = keys.iter().filter_map(|k| normalize(k)).take(MAX_BATCH).collect();
    let missing: Vec<String> = {
        let mut guard = CACHE.lock_safe();
        let cache = guard.get_or_insert_with(HashMap::new);
        let mut m: Vec<String> = wanted.iter().filter(|k| !cache.contains_key(*k)).cloned().collect();
        m.sort();
        m.dedup();
        m
    };
    if !missing.is_empty() {
        let extracted = extract_on_sta_thread(missing.clone());
        let mut guard = CACHE.lock_safe();
        let cache = guard.get_or_insert_with(HashMap::new);
        for k in missing {
            let v = extracted.get(&k).cloned();
            cache.insert(k, v);
        }
    }
    let guard = CACHE.lock_safe();
    let cache = guard.as_ref();
    wanted
        .into_iter()
        .filter_map(|k| cache.and_then(|c| c.get(&k).cloned().flatten()).map(|v| (k, v)))
        .collect()
}

/// Shell 图标 API 需要在已初始化 COM 的线程上调用；用独立线程，避免影响 Tauri 线程池的 COM 模式。
fn extract_on_sta_thread(keys: Vec<String>) -> HashMap<String, String> {
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            win::extract(&keys)
        }
        #[cfg(not(windows))]
        {
            let _ = keys;
            HashMap::new()
        }
    })
    .join()
    .unwrap_or_default()
}

#[cfg(windows)]
mod win {
    use super::FOLDER_KEY;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Controls::IImageList;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES, SHIL_EXTRALARGE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// ILD_TRANSPARENT
    const ILD_TRANSPARENT: u32 = 0x1;

    pub fn extract(keys: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let list: Option<IImageList> = SHGetImageList(SHIL_EXTRALARGE as i32).ok();
            if let Some(list) = list {
                for key in keys {
                    if let Some(url) = icon_for_key(&list, key) {
                        out.insert(key.clone(), url);
                    }
                }
            }
            if com.is_ok() {
                CoUninitialize();
            }
        }
        out
    }

    unsafe fn icon_for_key(list: &IImageList, key: &str) -> Option<String> {
        let (name, attr) = if key == FOLDER_KEY {
            ("folder".to_string(), FILE_ATTRIBUTE_DIRECTORY)
        } else if key.is_empty() {
            ("file".to_string(), FILE_ATTRIBUTE_NORMAL)
        } else {
            (format!("file.{key}"), FILE_ATTRIBUTE_NORMAL)
        };
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut info = SHFILEINFOW::default();
        // USEFILEATTRIBUTES：只按名字与属性查询关联，不访问磁盘，文件无需真实存在
        let r = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            attr,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES,
        );
        if r == 0 {
            return None;
        }
        let hicon: HICON = list.GetIcon(info.iIcon, ILD_TRANSPARENT).ok()?;
        let png = hicon_to_png(hicon);
        let _ = DestroyIcon(hicon);
        png.map(|bytes| format!("data:image/png;base64,{}", base64(&bytes)))
    }

    /// HICON → RGBA → PNG。系统图像列表里的图标是 32 位带 alpha；极少数旧式图标无 alpha 时用掩码补透明度。
    unsafe fn hicon_to_png(hicon: HICON) -> Option<Vec<u8>> {
        let mut ii = ICONINFO::default();
        GetIconInfo(hicon, &mut ii).ok()?;
        let result = (|| {
            if ii.hbmColor.is_invalid() {
                return None;
            }
            let mut bm = BITMAP::default();
            let got = GetObjectW(
                HGDIOBJ(ii.hbmColor.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut BITMAP as *mut c_void),
            );
            if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 || bm.bmWidth > 256 || bm.bmHeight > 256 {
                return None;
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            let color = dib_bits(ii.hbmColor, w, h)?;
            let mut rgba = Vec::with_capacity(color.len());
            let (pixels, _) = color.as_chunks::<4>();
            let has_alpha = pixels.iter().any(|p| p[3] != 0);
            let mask = if has_alpha || ii.hbmMask.is_invalid() { None } else { dib_bits(ii.hbmMask, w, h) };
            for (i, p) in pixels.iter().enumerate() {
                let a = if has_alpha {
                    p[3]
                } else if let Some(m) = &mask {
                    // 掩码：黑（0）= 不透明，白 = 透明
                    if m[i * 4] == 0 { 255 } else { 0 }
                } else {
                    255
                };
                rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
            }
            encode_png(&rgba, w as u32, h as u32)
        })();
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        result
    }

    /// 读取位图为自上而下的 32 位 BGRA 像素
    unsafe fn dib_bits(bmp: windows::Win32::Graphics::Gdi::HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = CreateCompatibleDC(None);
        let lines = GetDIBits(hdc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteDC(hdc);
        (lines == h).then_some(buf)
    }

    fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().ok()?;
            writer.write_image_data(rgba).ok()?;
        }
        Some(out)
    }

    fn base64(bytes: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            s.push(T[(n >> 18) as usize & 63] as char);
            s.push(T[(n >> 12) as usize & 63] as char);
            s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        s
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn base64_matches_rfc4648() {
            assert_eq!(super::base64(b""), "");
            assert_eq!(super::base64(b"f"), "Zg==");
            assert_eq!(super::base64(b"fo"), "Zm8=");
            assert_eq!(super::base64(b"foo"), "Zm9v");
            assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_path_like_keys() {
        assert_eq!(normalize(".TXT").as_deref(), Some("txt"));
        assert_eq!(normalize("tar.gz"), None, "点号不属于单个扩展名");
        assert_eq!(normalize("../x"), None);
        assert_eq!(normalize("a\\b"), None);
        assert_eq!(normalize(FOLDER_KEY).as_deref(), Some(FOLDER_KEY));
        assert_eq!(normalize("").as_deref(), Some(""));
    }

    /// 真实调用 Windows Shell：txt 与文件夹在任何 Windows 上都有系统图标，且为有效 PNG
    #[cfg(windows)]
    #[test]
    fn extracts_real_system_icons_as_png() {
        let map = icons_for(vec!["txt".into(), FOLDER_KEY.into(), "../bad".into()]);
        for key in ["txt", FOLDER_KEY] {
            let url = map.get(key).unwrap_or_else(|| panic!("{key} 应有系统图标"));
            assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"), "{key} 应为 PNG data URL");
        }
        assert!(!map.contains_key("../bad"));
        // 第二次命中缓存
        let again = icons_for(vec!["txt".into()]);
        assert_eq!(again.get("txt"), map.get("txt"));
    }
}
