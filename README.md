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
- Real-time validation of game files

### 📦 **WAD Archive Operations**
- High-performance WAD file reading and extraction
- Automatic hash resolution via CommunityDragon
- Selective asset extraction for champions and skins

### 🔧 **BIN File Editor**
- Full BIN property file parsing and visualization
- Tree-based property editor with syntax highlighting
- Support for all BIN data types (vectors, colors, hashes, links, etc.)

### 🖼️ **Asset Preview**
- **Textures**: DDS and TEX file decoding with full format support
- **Animations**: ANM file preview
- **Audio**: Built-in audio player for extracted sounds
- **Text**: Syntax-highlighted text file viewing

### 📤 **Mod Export**
- Export to `.fantome` format (compatible with cslol-manager)
- Export to `.modpkg` format *(coming soon)*
- Automatic asset repathing for mod compatibility

---

## 🚧 Work in Progress

> **Note:** The following features are actively being developed and may have limited functionality:

| Feature | Status | Description |
|---------|--------|-------------|
| **Refather System** | 🔨 In Development | Intelligent asset path rewriting for custom skins |
| **BIN Concatenation** | 🔨 In Development | Automatic merging of linked BIN files into optimized bundles |

---

## 🏗️ Project Structure

```
flint/
├── src/                    # React TypeScript Frontend
│   ├── components/         # UI Components
│   │   ├── modals/         # Modal dialogs
│   │   └── preview/        # Asset preview panels
│   ├── lib/                # Utilities & API
│   └── themes/             # Customizable themes
│
├── src-tauri/              # Rust Backend
│   ├── src/
│   │   ├── commands/       # Tauri IPC handlers
│   │   ├── core/           # Core functionality
│   │   │   ├── bin/        # BIN file operations
│   │   │   ├── export/     # Mod export system
│   │   │   ├── league/     # Game detection
│   │   │   ├── repath/     # Asset repathing
│   │   │   └── wad/        # WAD operations
│   │   └── utils/          # Shared utilities
│   └── Cargo.toml          # Rust dependencies
│
└── docs/                   # Documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Rust** (1.70+ stable)
- **Node.js** (v18+)
- **pnpm** or **npm**

### Installation

```bash
# Clone the repository
git clone https://github.com/DexalGT/Flint.git
cd Flint

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
| **Frontend** | React 18, TypeScript, Vite |
| **Backend** | Rust, Tauri 2.0 |
| **BIN Parsing** | Custom ritobin_rust implementation |
| **Texture Decoding** | texture2ddecoder, image-rs |
| **Archive Handling** | Custom WAD parser |

---

## 📜 License

This project is for educational purposes. League of Legends and all related assets are property of Riot Games.

---

<p align="center">
  <strong>Made with ❤️ for the League modding community</strong>
</p>
