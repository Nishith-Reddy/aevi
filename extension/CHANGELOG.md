# Changelog

All notable changes to Aevi will be documented here.

## [0.0.1] — 2026-03-26

### Initial release

- Chat mode with file context and RAG-powered workspace search
- Agent mode with step-by-step planning, diff preview, and accept/reject per edit
- Inline code completions (Beta)
- Multi-provider support: Ollama, OpenAI, Anthropic, Groq, Gemini, LM Studio, llama.cpp, vLLM
- Live model list fetched from each provider API
- API keys stored securely via VS Code SecretStorage
- Local provider URLs configurable from the settings panel
- Automatic file indexing on workspace open
- Context-aware RAG scoped to selected files only
- Smart scroll — auto-scroll pauses when reading, resumes on new message
- Dark mode support throughout