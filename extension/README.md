# Aevi — AI Coding Assistant

**Aevi** is an AI-powered coding assistant built into VS Code. It supports local LLMs via Ollama, vLLM as well as cloud APIs (OpenAI, Anthropic, Groq, Gemini), giving you full control over your model and your data.

---

## Features

- **Chat** — ask questions about your code with full file context
- **Agent** — autonomously make changes to your codebase with accept/reject diffs
- **Inline completions** — AI suggestions as you type (Beta)
- **RAG** — semantic search over your workspace for accurate context
- **Multi-provider** — Ollama, OpenAI, Anthropic, Groq, Gemini, LM Studio, llama.cpp, vLLM
- **Model picker** — switch models instantly from the sidebar
- **Privacy-first** — run entirely locally with Ollama, no data leaves your machine

---

## Requirements

Aevi requires python3.11 or above.

The server runs on `http://127.0.0.1:8765` by default.

---

## Setup

### Local models (Ollama)

1. Install [Ollama](https://ollama.com)
2. Pull a model: `ollama pull qwen2.5-coder:7b`
3. Open Aevi settings in the sidebar and set the Ollama URL (default: `http://localhost:11434`)

### Cloud APIs

Open the ⚙ settings panel in the Aevi sidebar and enter your API keys:

| Provider  | Key format |
|-----------|------------|
| Anthropic | `sk-ant-...` |
| OpenAI    | `sk-...` |
| Groq      | `gsk_...` |
| Gemini    | `AIza...` |

Keys are stored securely using VS Code's built-in secret storage.

---

## Usage

### Chat mode
Ask questions about your code. The currently open file is automatically added as context. Use **+ Add file** to pin additional files.

### Agent mode
Describe a task and Aevi will plan and execute it step by step, showing you a diff before applying any change. You can accept or reject each edit.

### Inline completions
Enable via the ⚙ settings toggle. Works best with `qwen2.5-coder` or `codellama` models.

### Index workspace
Run **Aevi: Index Workspace** from the command palette to enable semantic search (RAG) across all your project files.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aevi.backendUrl` | `http://127.0.0.1:8765` | URL of the Aevi backend server |
| `aevi.enableInlineCompletion` | `false` | Enable inline code completions (Beta) |

---

## Supported Models

**Local:** Ollama, LM Studio, llama.cpp, vLLM

**Cloud:** OpenAI, Anthropic, Groq, Gemini

Model lists are fetched live from each provider — you see exactly what your API key has access to.

---

## License

MIT