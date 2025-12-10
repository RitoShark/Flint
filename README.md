<p align="center">
  <img src="https://img.shields.io/badge/League%20of%20Legends-Modding-C89B3C?style=for-the-badge&logo=riotgames&logoColor=white" alt="League Modding">
  <img src="https://img.shields.io/badge/Built%20with-Tauri%202.0-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-Backend-DEA584?style=for-the-badge&logo=rust&logoColor=black" alt="Rust">
  <img src="https://img.shields.io/badge/React-TypeScript-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<h1 align="center">🔥 FLINT</h1>
<h3 align="center">League of Legends Asset Extractor & Modding IDE</h3>

<p align="center">
  <em>A powerful, modern tool for extracting and modifying League of Legends champion skins and assets.</em>
</p>

---

## ✨ Features

### 🎮 **Smart Game Detection**
- Automatically detects League of Legends installation path
- Supports multiple installation methods (Riot Client, Steam, custom paths)
- Windows Registry integration for reliable detection
- Real-time validation of game files

### 📦 **WAD Archive Operations**
- High-performance WAD file reading and extraction using `league-toolkit`
- Automatic hash resolution via CommunityDragon hashtables
- Selective asset extraction for champions and skins
- Support for ZSTD and Deflate compression formats

### 🔧 **BIN File Editor**
- Full BIN property file parsing via `ltk_ritobin` / `ltk_meta`
- Python-like text representation (ritobin format)
- Pre-conversion of BIN files to `.ritobin` for instant loading
- Support for all BIN data types:
  - Primitives (bool, i8/u8, i16/u16, i32/u32, i64/u64, f32)
  - Vectors (Vec2, Vec3, Vec4) and Matrices (Mtx44)
  - Colors (RGBA) and Strings
  - Hashes, Links, Pointers, Embeds, and Options
  - Containers (List, Map, Optional)

### 🖼️ **Asset Preview**
- **Textures**: DDS and TEX file decoding (BC1, BC3, ETC formats) via `ltk_texture`
- **Hex Viewer**: Binary file inspection with offset display
- **Text**: Syntax-highlighted text file viewing
- **Images**: PNG/JPG preview with base64 encoding

### 📤 **Mod Export**
- Export to `.fantome` format (compatible with cslol-manager) via `ltk_fantome`
- Export to `.modpkg` format via `ltk_modpkg` *(coming soon)*
- Champion and skin metadata embedding

### 🎨 **Theming System**
- Customizable color themes via CSS variables
- Gray-red default palette with accent color swappable
- Dark mode optimized UI

---

## 🚧 Temporarily Disabled Features

> [!WARNING]
> **The following features are temporarily disabled** pending the release of a stable binary writing tool in the [LeagueToolkit](https://github.com/LeagueToolkit/league-toolkit) Rust crate. Once `ltk_ritobin` supports reliable BIN file writing, these features will be re-enabled.

| Feature | Status | Description |
|---------|--------|-------------|
| **Refather System** | ⏸️ Disabled | Intelligent asset path rewriting for custom skins. Renames asset paths in BIN files to use custom `ASSETS/{Creator}/{Project}/` prefixes. |
| **BIN Concatenation** | ⏸️ Disabled | Automatic merging of linked BIN files into optimized bundles. Creates `__Concat.bin` and updates main BIN's linked paths. |

These features have full implementations in `src-tauri/src/core/repath/refather.rs` and `src-tauri/src/core/bin/concat.rs` respectively, but are currently bypassed during project creation to prevent BIN file corruption issues.

---

## 🏗️ Project Structure

```
flint/
├── src/                        # React TypeScript Frontend
│   ├── components/             # UI Components
│   │   ├── modals/             # Modal dialogs
│   │   │   ├── NewProjectModal.tsx
│   │   │   ├── ExportModal.tsx
│   │   │   ├── SettingsModal.tsx
│   │   │   └── FirstTimeSetupModal.tsx
│   │   └── preview/            # Asset preview panels
│   │       ├── BinEditor.tsx
│   │       ├── ImagePreview.tsx
│   │       ├── TextPreview.tsx
│   │       └── HexViewer.tsx
│   ├── lib/                    # Utilities & API bridge
│   └── themes/                 # Customizable CSS themes
│
├── src-tauri/                  # Rust Backend
│   ├── src/
│   │   ├── commands/           # Tauri IPC handlers
│   │   │   ├── project.rs      # Project CRUD operations
│   │   │   ├── export.rs       # Mod export commands
│   │   │   ├── bin.rs          # BIN file operations
│   │   │   ├── file.rs         # File I/O & preview
│   │   │   ├── wad.rs          # WAD archive commands
│   │   │   └── hash.rs         # Hash resolution
│   │   ├── core/               # Core functionality
│   │   │   ├── bin/            # BIN parsing & operations
│   │   │   ├── wad/            # WAD extraction
│   │   │   ├── hash/           # CommunityDragon hashtables
│   │   │   ├── repath/         # Asset repathing (disabled)
│   │   │   ├── export/         # Fantome/Modpkg export
│   │   │   ├── league/         # Game detection
│   │   │   ├── project/        # Project management
│   │   │   ├── champion/       # Champion & skin discovery
│   │   │   └── validation/     # Asset validation
│   │   └── utils/              # Shared utilities
│   └── Cargo.toml              # Rust dependencies
│
└── docs/                       # Documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Rust** (1.70+ stable)
- **Node.js** (v18+)
- **npm** or **pnpm**

### Installation

```bash
# Clone the repository
git clone https://github.com/DexalGT/Flint.git
cd "Flint - Asset Extractor"

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Building

```bash
# Build optimized production binary
npm run tauri build
```

---

## 🎨 Theming

Flint supports custom color themes! Create your own theme by copying `src/themes/default.css` and modifying the CSS variables:

```css
:root {
  --accent-primary: #your-color;
  --accent-secondary: #your-secondary-color;
  /* ... */
}
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18, TypeScript, Vite 5 |
| **Backend** | Rust, Tauri 2.0 |
| **BIN Parsing** | `ltk_ritobin`, `ltk_meta` (LeagueToolkit) |
| **WAD Handling** | `league-toolkit` |
| **Texture Decoding** | `ltk_texture` (LeagueToolkit) |
| **Mod Export** | `ltk_fantome`, `ltk_modpkg`, `ltk_mod_project` |
| **Hash Resolution** | CommunityDragon hashtables, `xxhash-rust` |

---

## 📦 Key Dependencies

### Rust Backend
- `tauri` 2.0 - Cross-platform desktop framework
- `league-toolkit` - WAD archive operations
- `ltk_ritobin` / `ltk_meta` - BIN file parsing
- `ltk_fantome` / `ltk_modpkg` - Mod format export
- `ltk_texture` - DDS/TEX texture decoding (LeagueToolkit)
- `reqwest` - HTTP client for hash downloading
- `tokio` - Async runtime

### Frontend
- `@tauri-apps/api` 2.0 - Tauri JavaScript bindings
- `@tauri-apps/plugin-dialog` - Native file dialogs
- `react` 18.3 - UI framework
- `typescript` 5.6 - Type safety

---

## 📜 License

This project is for educational purposes. League of Legends and all related assets are property of Riot Games.

---

<p align="center">
  <strong>Made with ❤️ for the League modding community</strong>
</p>
