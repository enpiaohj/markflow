# 第三方组件声明

MarkFlow 以 **GPL-3.0-only** 发布（见 [LICENSE](LICENSE)）。下列第三方组件按各自许可随应用分发或参与构建，其许可均与 GPL-3.0 兼容（MIT / Apache-2.0 / BSD / ISC / MPL-2.0 / Zlib / Unicode / CC0 等宽松或弱 Copyleft 许可；双许可组件按可兼容的一项使用，如 jszip 选用 MIT）。

> 本清单由锁文件（package-lock.json、Cargo.lock）在 v0.6.0 发布时生成（`node scripts/gen-third-party-notices.mjs`），含平台条件依赖（仅在对应平台编译）与构建期依赖；各组件版权归其作者所有，许可全文见其上游仓库。

## 不随应用分发的外部工具

Pandoc（GPL-2.0-or-later）、LibreOffice（MPL-2.0 / LGPL-3.0-or-later）、Microsoft Edge（专有）与 Windows OCR（系统组件）**不随 MarkFlow 分发**：应用仅在用户本机已安装时，以独立进程（参数数组、无 Shell 拼接）调用它们；未安装时相应功能自动降级。

## 前端与构建（npm，生产依赖树，共 227 项）

### MIT（180）

@codemirror/autocomplete@6.20.3、@codemirror/commands@6.11.1、@codemirror/lang-css@6.3.1、@codemirror/lang-html@6.4.12、@codemirror/lang-javascript@6.2.5、@codemirror/lang-json@6.0.2、@codemirror/lang-markdown@6.5.2、@codemirror/lang-yaml@6.1.3、@codemirror/language@6.12.4、@codemirror/lint@6.9.7、@codemirror/search@6.7.2、@codemirror/state@6.7.5、@codemirror/view@6.43.12、@emnapi/core@1.11.1、@emnapi/runtime@1.11.1、@emnapi/wasi-threads@1.2.2、@floating-ui/core@1.8.0、@floating-ui/dom@1.8.0、@floating-ui/utils@0.2.12、@jridgewell/gen-mapping@0.3.13、@jridgewell/remapping@2.3.5、@jridgewell/resolve-uri@3.1.2、@jridgewell/sourcemap-codec@1.6.0、@jridgewell/trace-mapping@0.3.31、@lezer/common@1.5.2、@lezer/css@1.3.6、@lezer/highlight@1.2.3、@lezer/html@1.3.13、@lezer/javascript@1.5.5、@lezer/json@1.0.3、@lezer/lr@1.4.10、@lezer/markdown@1.7.2、@lezer/yaml@1.0.4、@marijn/find-cluster-break@1.0.4、@napi-rs/canvas-android-arm64@1.0.9、@napi-rs/canvas-darwin-arm64@1.0.9、@napi-rs/canvas-darwin-x64@1.0.9、@napi-rs/canvas-linux-arm-gnueabihf@1.0.9、@napi-rs/canvas-linux-arm64-gnu@1.0.9、@napi-rs/canvas-linux-arm64-musl@1.0.9、@napi-rs/canvas-linux-riscv64-gnu@1.0.9、@napi-rs/canvas-linux-x64-gnu@1.0.9、@napi-rs/canvas-linux-x64-musl@1.0.9、@napi-rs/canvas-win32-arm64-msvc@1.0.9、@napi-rs/canvas-win32-x64-msvc@1.0.9、@napi-rs/canvas@1.0.9、@napi-rs/wasm-runtime@1.1.4、@oxc-project/types@0.150.0、@rolldown/binding-android-arm-eabi@1.2.9、@rolldown/binding-android-arm64@1.2.9、@rolldown/binding-darwin-arm64@1.2.9、@rolldown/binding-darwin-x64@1.2.9、@rolldown/binding-freebsd-x64@1.2.9、@rolldown/binding-linux-arm-gnueabihf@1.2.9、@rolldown/binding-linux-arm64-gnu@1.2.9、@rolldown/binding-linux-arm64-musl@1.2.9、@rolldown/binding-linux-ppc64-gnu@1.2.9、@rolldown/binding-linux-s390x-gnu@1.2.9、@rolldown/binding-linux-x64-gnu@1.2.9、@rolldown/binding-linux-x64-musl@1.2.9、@rolldown/binding-openharmony-arm64@1.2.9、@rolldown/binding-win32-arm64-msvc@1.2.9、@rolldown/binding-win32-x64-msvc@1.2.9、@rolldown/pluginutils@1.0.1、@tailwindcss/node@4.3.3、@tailwindcss/oxide-android-arm64@4.3.3、@tailwindcss/oxide-darwin-arm64@4.3.3、@tailwindcss/oxide-darwin-x64@4.3.3、@tailwindcss/oxide-freebsd-x64@4.3.3、@tailwindcss/oxide-linux-arm-gnueabihf@4.3.3、@tailwindcss/oxide-linux-arm64-gnu@4.3.3、@tailwindcss/oxide-linux-arm64-musl@4.3.3、@tailwindcss/oxide-linux-x64-gnu@4.3.3、@tailwindcss/oxide-linux-x64-musl@4.3.3、@tailwindcss/oxide-wasm32-wasi@4.3.3、@tailwindcss/oxide-win32-arm64-msvc@4.3.3、@tailwindcss/oxide-win32-x64-msvc@4.3.3、@tailwindcss/oxide@4.3.3、@tailwindcss/vite@4.3.3、@tiptap/core@3.31.3、@tiptap/extension-blockquote@3.31.3、@tiptap/extension-bold@3.31.3、@tiptap/extension-bubble-menu@3.31.3、@tiptap/extension-bullet-list@3.31.3、@tiptap/extension-code-block@3.31.3、@tiptap/extension-code@3.31.3、@tiptap/extension-document@3.31.3、@tiptap/extension-dropcursor@3.31.3、@tiptap/extension-floating-menu@3.31.3、@tiptap/extension-gapcursor@3.31.3、@tiptap/extension-hard-break@3.31.3、@tiptap/extension-heading@3.31.3、@tiptap/extension-horizontal-rule@3.31.3、@tiptap/extension-image@3.31.3、@tiptap/extension-italic@3.31.3、@tiptap/extension-link@3.31.3、@tiptap/extension-list-item@3.31.3、@tiptap/extension-list-keymap@3.31.3、@tiptap/extension-list@3.31.3、@tiptap/extension-ordered-list@3.31.3、@tiptap/extension-paragraph@3.31.3、@tiptap/extension-strike@3.31.3、@tiptap/extension-table-cell@3.31.3、@tiptap/extension-table-header@3.31.3、@tiptap/extension-table-row@3.31.3、@tiptap/extension-table@3.31.3、@tiptap/extension-task-item@3.31.3、@tiptap/extension-task-list@3.31.3、@tiptap/extension-text@3.31.3、@tiptap/extension-underline@3.31.3、@tiptap/extensions@3.31.3、@tiptap/pm@3.31.3、@tiptap/react@3.31.3、@tiptap/starter-kit@3.31.3、@tybys/wasm-util@0.10.2、@types/linkify-it@3.0.5、@types/linkify-it@5.0.0、@types/markdown-it@13.0.9、@types/markdown-it@14.2.0、@types/mdurl@1.0.5、@types/mdurl@2.0.0、@types/react-dom@19.3.0、@types/react@19.3.0、@types/use-sync-external-store@0.0.6、codemirror@6.0.2、core-util-is@1.0.3、crelt@1.0.7、csstype@3.2.3、enhanced-resolve@5.25.1、fast-equals@5.4.3、fdir@6.5.0、fsevents@2.3.3、immediate@3.0.6、isarray@1.0.0、jiti@2.7.0、lie@3.3.0、linkify-it@5.0.2、linkifyjs@4.3.3、magic-string@0.30.21、markdown-it@14.3.2、mdurl@2.1.0、nanoid@3.3.19、orderedmap@2.1.1、picomatch@4.0.7、postcss@8.5.28、process-nextick-args@2.0.1、prosemirror-changeset@2.4.3、prosemirror-commands@1.7.2、prosemirror-dropcursor@1.8.3、prosemirror-gapcursor@1.4.1、prosemirror-history@1.5.0、prosemirror-inputrules@1.5.1、prosemirror-keymap@1.2.3、prosemirror-markdown@1.13.7、prosemirror-model@1.25.11、prosemirror-schema-list@1.5.1、prosemirror-state@1.4.4、prosemirror-tables@1.8.5、prosemirror-transform@1.12.1、prosemirror-view@1.42.4、punycode.js@2.3.1、react-dom@19.3.0、react@19.3.0、readable-stream@2.3.8、rolldown@1.2.9、rope-sequence@1.3.4、safe-buffer@5.1.2、scheduler@0.28.0、setimmediate@1.0.5、string_decoder@1.1.1、style-mod@4.1.4、tailwindcss@4.3.3、tapable@2.3.3、tinyglobby@0.2.17、tiptap-markdown@0.9.0、uc.micro@2.1.0、use-sync-external-store@1.7.0、util-deprecate@1.0.2、vite@8.3.0、w3c-keyname@2.2.8

### MPL-2.0（25）

lightningcss-android-arm64@1.32.0、lightningcss-android-arm64@1.33.0、lightningcss-darwin-arm64@1.32.0、lightningcss-darwin-arm64@1.33.0、lightningcss-darwin-x64@1.32.0、lightningcss-darwin-x64@1.33.0、lightningcss-freebsd-x64@1.32.0、lightningcss-freebsd-x64@1.33.0、lightningcss-linux-arm-gnueabihf@1.32.0、lightningcss-linux-arm-gnueabihf@1.33.0、lightningcss-linux-arm64-gnu@1.32.0、lightningcss-linux-arm64-gnu@1.33.0、lightningcss-linux-arm64-musl@1.32.0、lightningcss-linux-arm64-musl@1.33.0、lightningcss-linux-x64-gnu@1.32.0、lightningcss-linux-x64-gnu@1.33.0、lightningcss-linux-x64-musl@1.32.0、lightningcss-linux-x64-musl@1.33.0、lightningcss-win32-arm64-msvc@1.32.0、lightningcss-win32-arm64-msvc@1.33.0、lightningcss-win32-x64-msvc@1.32.0、lightningcss-win32-x64-msvc@1.33.0、lightningcss@1.32.0、lightningcss@1.33.0、mtx-decompressor@1.6.0

### Apache-2.0（5）

@aiden0z/pptx-renderer@1.3.0、detect-libc@2.1.2、docx-preview@0.4.0、echarts@6.1.0、pdfjs-dist@6.3.289

### ISC（5）

graceful-fs@4.2.11、inherits@2.0.4、lucide-react@1.47.0、markdown-it-task-lists@2.1.1、picocolors@1.1.1

### BSD-3-Clause（3）

diff@9.0.0、source-map-js@1.2.1、zrender@6.1.0

### 0BSD（2）

tslib@2.3.0、tslib@2.8.1

### MIT OR Apache-2.0（2）

@tauri-apps/plugin-dialog@2.7.3、@tauri-apps/plugin-opener@2.5.5

### Apache-2.0 OR MIT（1）

@tauri-apps/api@2.11.1

### Python-2.0（1）

argparse@2.0.1

### BSD-2-Clause（1）

entities@4.5.0

### (MIT OR GPL-3.0-or-later)（1）

jszip@3.10.2

### (MIT AND Zlib)（1）

pako@1.0.11

## Rust 后端（Cargo，共 550 项）

### MIT OR Apache-2.0（277）

ahash@0.8.12、android_system_properties@0.1.6、anyhow@1.0.104、arbitrary@1.4.2、async-broadcast@0.7.2、async-recursion@1.1.1、async-trait@0.1.92、base64@0.21.7、base64@0.22.1、base64@0.23.1、bitflags@1.3.2、bitflags@2.13.2、block-buffer@0.10.4、bs58@0.5.1、bumpalo@3.20.3、camino@1.2.6、cargo-platform@0.1.9、cc@1.4.7、cfg-expr@0.15.8、cfg-if@1.0.5、chacha20@0.10.2、chrono@0.4.45、cookie@0.18.2、core-foundation-sys@0.8.7、core-foundation@0.10.1、core-graphics-types@0.2.0、core-graphics@0.25.0、core_detect@1.0.0、cpufeatures@0.2.17、cpufeatures@0.3.1、crc32fast@1.5.2、crossbeam-channel@0.5.17、crossbeam-utils@0.8.23、crypto-common@0.1.7、defmt-macros@1.1.1、defmt-parser@1.0.0、defmt@1.1.1、deranged@0.5.8、derive_arbitrary@1.4.2、digest@0.10.7、dirs-sys@0.5.0、dirs@6.0.0、displaydoc@0.2.7、dtoa@1.0.11、dyn-clone@1.0.20、embed_plist@1.2.2、enumflags2@0.7.12、enumflags2_derive@0.7.12、erased-serde@0.4.10、errno@0.3.14、fallible-iterator@0.3.0、fallible-streaming-iterator@0.1.9、fdeflate@0.3.7、field-offset@0.3.6、filetime@0.2.29、find-msvc-tools@0.1.13、flate2@1.1.10、foreign-types-macros@0.2.4、foreign-types-shared@0.3.1、foreign-types@0.5.0、form_urlencoded@1.2.2、futures-channel@0.3.34、futures-core@0.3.34、futures-executor@0.3.34、futures-io@0.3.34、futures-macro@0.3.34、futures-sink@0.3.34、futures-task@0.3.34、futures-util@0.3.34、getrandom@0.2.17、getrandom@0.3.4、getrandom@0.4.3、glob@0.3.4、hashbrown@0.12.3、hashbrown@0.14.5、hashbrown@0.17.1、hashlink@0.9.1、heck@0.4.1、heck@0.5.0、hermit-abi@0.5.3、hex@0.4.3、html5ever@0.38.0、http@1.5.0、httparse@1.10.1、iana-time-zone-haiku@0.1.2、iana-time-zone@0.1.65、ident_case@1.0.1、idna@1.1.0、ipnet@2.12.2、itoa@1.0.18、jni-sys-macros@0.4.1、jni-sys@0.3.1、jni-sys@0.4.1、jni@0.21.1、js-sys@0.3.105、json-patch@3.0.1、jsonptr@0.6.3、keyboard-types@0.7.0、keyring@3.6.3、libc@0.2.189、lock_api@0.4.14、log@0.4.34、markup5ever@0.38.0、mime@0.3.17、multiversion-macros@0.9.0、multiversion@0.9.0、ndk-sys@0.6.0+11769913、ndk@0.9.0、notify-types@1.0.1、num-conv@0.2.2、num-traits@0.2.19、once_cell@1.21.4、ordered-stream@0.2.0、parking_lot@0.12.5、parking_lot_core@0.9.12、percent-encoding@2.3.2、piper@0.2.5、pkg-config@0.3.34、png@0.17.16、png@0.18.1、powerfmt@0.2.0、proc-macro-crate@1.3.1、proc-macro-crate@2.0.2、proc-macro-crate@3.5.0、proc-macro-error-attr@1.0.4、proc-macro-error@1.0.4、proc-macro2@1.0.107、quinn-proto@0.11.18、quinn-udp@0.5.15、quinn@0.11.12、quote@1.0.47、rand@0.10.3、rand_core@0.10.1、rand_pcg@0.10.2、ref-cast-impl@1.0.27、ref-cast@1.0.27、regex-automata@0.4.18、regex-syntax@0.8.11、regex@1.13.1、reqwest@0.12.28、reqwest@0.13.5、roxmltree@0.20.0、rustc_version@0.4.1、rustls-pki-types@1.15.1、rustversion@1.0.23、scopeguard@1.2.0、semver@1.0.28、serde-untagged@0.1.9、serde@1.0.229、serde_core@1.0.229、serde_derive@1.0.229、serde_derive_internals@0.29.1、serde_json@1.0.151、serde_repr@0.1.21、serde_spanned@0.6.9、serde_spanned@1.1.1、serde_urlencoded@0.7.1、serde_with@3.23.0、serde_with_macros@3.23.0、serialize-to-javascript-impl@0.1.2、serialize-to-javascript@0.1.2、servo_arc@0.4.3、sha2@0.10.9、shlex@2.0.1、signal-hook-registry@1.4.8、simdutf8@0.1.5、siphasher@1.0.3、smallvec@1.16.1、socket2@0.6.5、softbuffer@0.4.8、stable_deref_trait@1.2.1、string_cache@0.9.0、string_cache_codegen@0.6.1、swift-rs@1.0.8、syn@1.0.109、syn@2.0.119、syn@3.0.6、system-deps@6.2.2、tao-macros@0.1.4、tempfile@3.27.0、tendril@0.5.1、thiserror-impl@1.0.69、thiserror-impl@2.0.20、thiserror@1.0.69、thiserror@2.0.20、time-core@0.1.9、time-macros@0.2.32、time@0.3.55、tokio-rustls@0.26.5、toml@0.8.2、toml@0.9.12+spec-1.1.0、toml@1.1.6+spec-1.1.0、toml_datetime@0.6.3、toml_datetime@0.7.5+spec-1.1.0、toml_datetime@1.1.1+spec-1.1.0、toml_edit@0.19.15、toml_edit@0.20.2、toml_edit@0.25.15+spec-1.1.0、toml_parser@1.1.3+spec-1.1.0、toml_writer@1.1.2+spec-1.1.0、tray-icon@0.24.2、typeid@1.0.3、typenum@1.20.1、unic-char-property@0.9.0、unic-char-range@0.9.0、unic-common@0.9.0、unic-ucd-ident@0.9.0、unic-ucd-version@0.9.0、unicode-segmentation@1.13.3、url@2.5.8、vcpkg@0.2.15、version_check@0.9.5、wasm-bindgen-futures@0.4.78、wasm-bindgen-macro-support@0.2.128、wasm-bindgen-macro@0.2.128、wasm-bindgen-shared@0.2.128、wasm-bindgen@0.2.128、wasm-streams@0.4.2、wasm-streams@0.5.0、web-sys@0.3.105、web-time@1.1.0、web_atoms@0.2.6、winapi-i686-pc-windows-gnu@0.4.0、winapi-x86_64-pc-windows-gnu@0.4.0、winapi@0.3.9、windows-collections@0.2.0、windows-collections@0.3.2、windows-core@0.61.2、windows-core@0.62.2、windows-future@0.2.1、windows-future@0.3.2、windows-implement@0.60.2、windows-interface@0.59.3、windows-link@0.1.3、windows-link@0.2.1、windows-numerics@0.2.0、windows-numerics@0.3.1、windows-result@0.3.4、windows-result@0.4.1、windows-strings@0.4.2、windows-strings@0.5.1、windows-sys@0.45.0、windows-sys@0.52.0、windows-sys@0.59.0、windows-sys@0.60.2、windows-sys@0.61.2、windows-targets@0.42.2、windows-targets@0.52.6、windows-targets@0.53.5、windows-threading@0.1.0、windows-threading@0.2.1、windows-version@0.1.7、windows@0.61.3、windows@0.62.2、windows_aarch64_gnullvm@0.42.2、windows_aarch64_gnullvm@0.52.6、windows_aarch64_gnullvm@0.53.1、windows_aarch64_msvc@0.42.2、windows_aarch64_msvc@0.52.6、windows_aarch64_msvc@0.53.1、windows_i686_gnu@0.42.2、windows_i686_gnu@0.52.6、windows_i686_gnu@0.53.1、windows_i686_gnullvm@0.52.6、windows_i686_gnullvm@0.53.1、windows_i686_msvc@0.42.2、windows_i686_msvc@0.52.6、windows_i686_msvc@0.53.1、windows_x86_64_gnu@0.42.2、windows_x86_64_gnu@0.52.6、windows_x86_64_gnu@0.53.1、windows_x86_64_gnullvm@0.42.2、windows_x86_64_gnullvm@0.52.6、windows_x86_64_gnullvm@0.53.1、windows_x86_64_msvc@0.42.2、windows_x86_64_msvc@0.52.6、windows_x86_64_msvc@0.53.1

### MIT（122）

atk-sys@0.18.2、atk@0.18.2、block2@0.6.2、bytes@1.12.1、cairo-rs@0.18.5、cairo-sys-rs@0.18.2、cargo_metadata@0.19.2、cfb@0.7.3、cfg_aliases@0.2.2、combine@4.6.8、darling@0.24.1、darling_core@0.24.1、darling_macro@0.24.1、derive_more-impl@2.1.1、derive_more@2.1.1、dlopen2@0.8.2、dlopen2_derive@0.4.3、dom_query@0.27.0、embed-resource@3.0.11、endi@1.1.1、fsevent-sys@4.1.0、gdk-pixbuf-sys@0.18.0、gdk-pixbuf@0.18.5、gdk-sys@0.18.2、gdk@0.18.2、gdkwayland-sys@0.18.2、gdkx11-sys@0.18.2、gdkx11@0.18.2、generic-array@0.14.7、gio-sys@0.18.1、gio@0.18.4、glib-macros@0.18.5、glib-sys@0.18.1、glib@0.18.5、gobject-sys@0.18.0、gtk-sys@0.18.2、gtk3-macros@0.18.2、gtk@0.18.2、http-body-util@0.1.5、http-body@1.1.0、hyper-util@0.1.20、hyper@1.11.1、ico@0.5.0、infer@0.19.0、is-docker@0.2.0、is-wsl@0.4.0、javascriptcore-rs-sys@1.1.1、javascriptcore-rs@1.1.2、kqueue-sys@1.1.2、kqueue@1.2.1、libredox@0.1.24、libsqlite3-sys@0.30.1、memoffset@0.9.1、mio@1.2.3、new_debug_unreachable@1.0.6、objc2-encode@4.1.0、objc2-foundation@0.3.2、objc2@0.6.4、open@5.4.4、pango-sys@0.18.0、pango@0.18.3、phf@0.13.1、phf_codegen@0.13.1、phf_generator@0.13.1、phf_macros@0.13.1、phf_shared@0.13.1、plist@1.10.1、precomputed-hash@0.1.1、quick-xml@0.42.0、redox_syscall@0.5.18、redox_users@0.5.3、rfd@0.16.0、rusqlite@0.32.1、schemars@0.8.22、schemars@0.9.0、schemars@1.2.2、schemars_derive@0.8.22、simd-adler32@0.3.10、slab@0.4.12、soup3-sys@0.5.0、soup3@0.5.0、strsim@0.11.1、synstructure@0.14.0、tauri-winres@0.3.6、tokio-util@0.7.19、tokio@1.53.1、tower-http@0.6.11、tower-layer@0.3.3、tower-service@0.3.3、tower@0.5.3、tracing-attributes@0.1.31、tracing-core@0.1.36、tracing@0.1.44、trash@5.2.9、try-lock@0.2.5、uds_windows@1.2.1、urlencoding@2.1.3、urlpattern@0.3.0、version-compare@0.2.1、vswhom-sys@0.1.3、vswhom@0.1.0、want@0.3.1、webkit2gtk-sys@2.0.2、webkit2gtk@2.0.2、webview2-com-macros@0.8.1、webview2-com-sys@0.38.2、webview2-com@0.38.2、winnow@0.5.40、winnow@0.7.15、winnow@1.0.4、winreg@0.55.0、x11-dl@2.21.0、x11@2.21.0、zbus@5.19.0、zbus_macros@5.19.0、zbus_names@4.3.4、zcheapstr@1.1.0、zip@2.4.2、zmij@1.0.23、zvariant@5.15.0、zvariant_derive@5.15.0、zvariant_utils@4.2.0

### Apache-2.0 OR MIT（56）

async-channel@2.5.0、async-executor@1.14.0、async-io@2.6.0、async-lock@3.4.2、async-process@2.5.0、async-signal@0.2.14、async-task@4.7.1、atomic-waker@1.1.2、autocfg@1.5.1、bit-set@0.8.0、bit-vec@0.8.0、blocking@1.7.0、cargo_toml@0.22.3、cesu8@1.1.0、concurrent-queue@2.5.0、ctor-proc-macro@0.0.7、ctor@0.8.0、dbus@0.9.12、dtor-proc-macro@0.0.6、dtor@0.3.0、equivalent@1.0.2、event-listener-strategy@0.5.4、event-listener@5.4.2、fastrand@2.5.0、futures-lite@2.6.1、idna_adapter@1.2.2、indexmap@1.9.3、indexmap@2.14.2、libappindicator-sys@0.9.0、libappindicator@0.9.0、libdbus-sys@0.2.7、muda@0.19.3、multiversion_no_op@1.0.0、parking@2.2.1、pin-project-lite@0.2.17、polling@3.11.0、portable-atomic-util@0.2.8、portable-atomic@1.15.0、rustc-hash@2.1.3、tauri-build@2.6.3、tauri-codegen@2.6.3、tauri-macros@2.6.3、tauri-plugin-dialog@2.7.3、tauri-plugin-fs@2.5.2、tauri-plugin-opener@2.5.5、tauri-plugin-single-instance@2.4.5、tauri-plugin@2.6.3、tauri-runtime-wry@2.11.4、tauri-runtime@2.11.3、tauri-utils@2.9.3、tauri@2.11.6、utf8_iter@1.0.4、uuid@1.26.1、window-vibrancy@0.6.0、wry@0.55.1、zeroize@1.9.0

### Unicode-3.0（18）

icu_collections@2.3.0、icu_locale_core@2.3.0、icu_normalizer@2.3.0、icu_normalizer_data@2.3.0、icu_properties@2.3.0、icu_properties_data@2.3.0、icu_provider@2.3.1、litemap@0.8.3、potential_utf@0.1.6、tinystr@0.8.4、writeable@0.6.4、yoke-derive@0.8.3、yoke@0.8.3、zerofrom-derive@0.1.8、zerofrom@0.1.8、zerotrie@0.2.5、zerovec-derive@0.11.6、zerovec@0.11.8

### Zlib OR Apache-2.0 OR MIT（17）

bytemuck@1.25.2、dispatch2@0.3.1、objc2-app-kit@0.3.2、objc2-cloud-kit@0.3.2、objc2-core-data@0.3.2、objc2-core-foundation@0.3.2、objc2-core-graphics@0.3.2、objc2-core-image@0.3.2、objc2-core-location@0.3.2、objc2-core-text@0.3.2、objc2-exception-helper@0.1.1、objc2-io-surface@0.3.2、objc2-quartz-core@0.3.2、objc2-ui-kit@0.3.2、objc2-user-notifications@0.3.2、objc2-web-kit@0.3.2、tinyvec@1.13.3

### Unlicense OR MIT（11）

aho-corasick@1.1.5、byteorder@1.5.0、jiff-core@0.1.1、jiff-static@0.2.37、jiff-tzdb-platform@0.1.3、jiff-tzdb@0.1.8、jiff@0.2.37、memchr@2.8.3、same-file@1.0.6、walkdir@2.5.0、winapi-util@0.1.11

### MPL-2.0（5）

cssparser-macros@0.6.1、cssparser@0.36.0、dtoa-short@0.3.5、option-ext@0.2.0、selectors@0.36.1

### ISC（5）

inotify-sys@0.1.8、inotify@0.10.2、libloading@0.7.4、rustls-webpki@0.103.15、untrusted@0.9.0

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT（5）

linux-raw-sys@0.12.1、rustix@1.1.5、wasi@0.11.1+wasi-snapshot-preview1、wasip2@1.0.4+wasi-0.2.12、wit-bindgen@0.57.1

### BSD-3-Clause（4）

alloc-no-stdlib@2.0.4、alloc-stdlib@0.2.4、instant@0.1.13、subtle@2.6.1

### Apache-2.0（3）

sync_wrapper@1.0.2、tao@0.35.3、zopfli@0.8.3

### Zlib（2）

foldhash@0.2.0、zlib-rs@0.6.8

### Apache-2.0 OR ISC OR MIT（2）

hyper-rustls@0.27.10、rustls@0.23.45

### MIT OR Apache-2.0 OR Zlib（2）

lru-slab@0.1.3、raw-window-handle@0.6.2

### MIT OR Zlib OR Apache-2.0（2）

miniz_oxide@0.8.9、miniz_oxide@0.9.1

### BSD-3-Clause OR MIT OR Apache-2.0（2）

num_enum@0.7.6、num_enum_derive@0.7.6

### MIT OR Apache-2.0 OR LGPL-2.1-or-later（2）

r-efi@5.3.0、r-efi@6.0.0

### BSD-2-Clause OR Apache-2.0 OR MIT（2）

zerocopy-derive@0.8.57、zerocopy@0.8.57

### 0BSD OR MIT OR Apache-2.0（1）

adler2@2.0.1

### BSD-3-Clause AND MIT（1）

brotli@8.0.4

### BSD-3-Clause OR MIT（1）

brotli-decompressor@5.0.3

### Apache-2.0 AND MIT（1）

dpi@0.1.2

### CC0-1.0 OR MIT-0 OR Apache-2.0（1）

dunce@1.0.5

### (Apache-2.0 OR MIT) AND BSD-3-Clause（1）

encoding_rs@0.8.41

### Apache-2.0  OR  MIT（1）

fnv@1.0.7

### CC0-1.0（1）

notify@7.0.0

### Apache-2.0 AND ISC（1）

ring@0.17.14

### Apache-2.0 OR BSL-1.0（1）

ryu@1.0.23

### Apache-2.0 WITH LLVM-exception（1）

target-lexicon@0.12.16

### (MIT OR Apache-2.0) AND Unicode-3.0（1）

unicode-ident@1.0.26

### CDLA-Permissive-2.0（1）

webpki-roots@1.0.9
