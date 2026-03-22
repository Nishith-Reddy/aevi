interface Model {
  name:   string;
  size?:  string;
  source: string;
}

interface Props {
  active:  string;
  local:   Model[];
  api:     Model[];
  onChange: (model: string) => void;
}

export default function ModelPicker({ active, local, api, onChange }: Props) {
  return (
    <select
      className="model-select"
      value={active}
      onChange={e => onChange(e.target.value)}
      title="Select model"
    >
      {local.length > 0 && (
        <optgroup label="Local (Ollama)">
          {local.map(m => (
            <option key={m.name} value={m.name}>
              {m.name.replace("ollama/", "")} {m.size ? `· ${m.size}` : ""}
            </option>
          ))}
        </optgroup>
      )}
      {api.length > 0 && (
        <optgroup label="Cloud API">
          {api.map(m => (
            <option key={m.name} value={m.name}>
              {m.name.replace(`${m.source}/`, "")} · {m.source}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}