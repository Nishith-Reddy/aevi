interface Model {
  name:   string;
  size?:  string;
  source: string;
}

interface Props {
  active:   string;
  local:    Model[];
  api:      Model[];
  onChange: (model: string) => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama:     "Ollama",
  anthropic:  "Anthropic",
  openai:     "OpenAI",
  groq:       "Groq",
  gemini:     "Gemini",
  "lm-studio": "LM Studio",
  "llama.cpp": "llama.cpp",
  vllm:       "vLLM",
};

function displayName(model: Model): string {
  // Strip provider prefix for display: "groq/llama-3.3-70b" → "llama-3.3-70b"
  // But keep sub-prefixes like "groq/openai/gpt-oss-20b" → "openai/gpt-oss-20b"
  const name = model.name;
  const source = model.source;
  const prefix = `${source}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export default function ModelPicker({ active, local, api, onChange }: Props) {
  // Group local models by source
  const localGroups: Record<string, Model[]> = {};
  for (const m of local) {
    const src = m.source ?? "local";
    if (!localGroups[src]) localGroups[src] = [];
    localGroups[src].push(m);
  }

  // Group cloud API models by source
  const apiGroups: Record<string, Model[]> = {};
  for (const m of api) {
    const src = m.source ?? "api";
    if (!apiGroups[src]) apiGroups[src] = [];
    apiGroups[src].push(m);
  }

  const hasLocal = local.length > 0;
  const hasApi   = api.length > 0;

  return (
    <select
      className="model-select"
      value={active}
      onChange={e => onChange(e.target.value)}
      title="Select model"
    >
      {hasLocal && Object.entries(localGroups).map(([src, models]) => (
        <optgroup key={src} label={`Local · ${PROVIDER_LABELS[src] ?? src}`}>
          {models.map(m => (
            <option key={m.name} value={m.name}>
              {displayName(m)}{m.size ? ` · ${m.size}` : ""}
            </option>
          ))}
        </optgroup>
      ))}

      {hasApi && Object.entries(apiGroups).map(([src, models]) => (
        <optgroup key={src} label={`Cloud · ${PROVIDER_LABELS[src] ?? src}`}>
          {models.map(m => (
            <option key={m.name} value={m.name}>
              {displayName(m)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}