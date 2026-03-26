export type Mode = "chat" | "agent";

const MODES: { id: Mode; label: string }[] = [
  { id: "chat",  label: "Chat"  },
  { id: "agent", label: "Agent" },
];

interface Props {
  active:   Mode;
  onChange: (mode: Mode) => void;
}

export default function ModeSelector({ active, onChange }: Props) {
  return (
    <div className="mode-selector">
      {MODES.map(m => (
        <button
          key={m.id}
          className={`mode-btn ${active === m.id ? "active" : ""}`}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}