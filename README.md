# <img src="extension/icon.png" width="45" align="top"> - AI Coding Assistant for VS Code

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/NishithReddyP.aevi?style=flat-square&color=blue)](https://marketplace.visualstudio.com/items?itemName=NishithReddyP.aevi)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/NishithReddyP.aevi?style=flat-square&color=blue)](https://marketplace.visualstudio.com/items?itemName=NishithReddyP.aevi)
[![Open VSX Version](https://img.shields.io/open-vsx/v/NishithReddyP/aevi?style=flat-square&color=blue)](https://open-vsx.org/extension/NishithReddyP/aevi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Aevi** is a powerful, flexible AI coding assistant extension for Visual Studio Code. Powered by a FastAPI and LiteLLM backend, it seamlessly bridges local and cloud-based Large Language Models (LLMs) to help you write, debug, and refactor code directly in your editor.

![Aevi Demo](demo links updating soon...)
---

## ✨ Key Features

* 🔄 **Bring Your Own Model (BYOM):** Connect to local providers (Ollama, LM Studio, vLLM, llama.cpp) or premium cloud APIs (OpenAI, Anthropic, Gemini, Groq).
* 📚 **Workspace Indexing (RAG):** Automatically parses and vectorizes your codebase. Ask questions, and Aevi will retrieve the most relevant files and code chunks to provide highly contextual answers.
* 💬 **Real-Time Chat Streaming:** Fast, responsive chat UI built directly into the VS Code sidebar.
* 🤖 **Agentic Workflows:** Let Aevi analyze a problem, propose a multi-file solution, and apply writes directly to your workspace.
* 💻 **Cross-Platform:** Fully tested and operational across Windows, macOS, and Linux.

---

## 🚀 Installation (For Users)

1. Open VS Code and navigate to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
2. Search for **Aevi**.
3. Click **Install**.
4. Alternatively, install it via the web from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=NishithReddyP.aevi) or [Open VSX](https://open-vsx.org/extension/NishithReddyP/aevi).

---

## ⚙️ Configuration & Usage

1. Open the Aevi sidebar in VS Code.
2. Click the **Settings** icon.
3. **For Cloud Models:** Enter your API keys (OpenAI, Anthropic, Gemini, Groq). These are securely stored in VS Code's native SecretStorage.
4. **For Local Models:** Add your local provider URL (e.g., `http://localhost:11434` for Ollama).
5. Open a codebase, and Aevi will automatically begin indexing your files for RAG. Ask your first question!

---

## 🛠️ Architecture

Aevi is split into two main components:
1. **Frontend (VS Code Extension):** Built with TypeScript and a Webview UI. It handles the editor context, file tracking, and user interface.
2. **Backend (FastAPI Server):** A Python-based local server that manages model routing (via LiteLLM), vector databases (for RAG), and the agentic logic. The extension automatically spins up this backend when activated.

---

## 🤝 Contributing

Aevi is an open-source project, and contributions are heavily encouraged! Whether you want to fix a bug, add a new feature, or improve the documentation, your help is welcome.

### How to Contribute
1. **Report a Bug:** Notice something broken? [Open an issue](../../issues) with a detailed description and steps to reproduce.
2. **Request a Feature:** Have an idea to make Aevi better? [Open an issue](../../issues) and use the "enhancement" tag.
3. **Submit a Pull Request:** * Fork the repository.
   * Create a new branch (`git checkout -b feature/amazing-feature`).
   * Make your changes.
   * Commit your changes (`git commit -m 'Add some amazing feature'`).
   * Push to the branch (`git push origin feature/amazing-feature`).
   * Open a Pull Request!

### Local Development Setup

**Prerequisites:** Node.js, Python3.11+, [uv](https://docs.astral.sh/uv/) (Python package manager), and VS Code.

```bash
# 1. Clone the repository
git clone [https://github.com/YOUR_USERNAME/aevi.git](https://github.com/YOUR_USERNAME/aevi.git)
cd aevi

# 2. Install extension dependencies
npm install

# 3. Install and build the Webview UI
# (Replace 'webview-ui' with the actual name of your frontend folder if different)
cd webview-ui
npm install
npm run build
cd ..

# 4. Set up the Python backend environment using uv
cd backend
uv sync  # Automatically creates the .venv and installs dependencies
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
cd ..

# 5. Compile the VS Code extension (You should be in the extensions directory)
npm run compile  # or npm run watch to auto-recompile on changes


# 6. Launch the Extension:
Open the root aevi folder in VS Code and press F5 (or go to Run and Debug -> Start Debugging). This will open a new "Extension Development Host" window where you can safely test your local build of Aevi!