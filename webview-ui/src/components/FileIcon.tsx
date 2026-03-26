interface Props {
  fileName: string;
  size?: number;
}

const EXT_META: Record<string, { color: string; label: string }> = {
  py:    { color: "#3572A5", label: "py" },
  js:    { color: "#F1E05A", label: "js" },
  ts:    { color: "#3178C6", label: "ts" },
  tsx:   { color: "#3178C6", label: "tsx" },
  jsx:   { color: "#61DAFB", label: "jsx" },
  go:    { color: "#00ADD8", label: "go" },
  rs:    { color: "#DEA584", label: "rs" },
  java:  { color: "#B07219", label: "java" },
  cpp:   { color: "#F34B7D", label: "cpp" },
  c:     { color: "#A8B9CC", label: "c" },
  h:     { color: "#A8B9CC", label: "h" },
  rb:    { color: "#CC342D", label: "rb" },
  swift: { color: "#F05138", label: "swift" },
  kt:    { color: "#A97BFF", label: "kt" },
  php:   { color: "#777BB4", label: "php" },
  cs:    { color: "#178600", label: "cs" },
  html:  { color: "#E34C26", label: "html" },
  css:   { color: "#563D7C", label: "css" },
  json:  { color: "#8BC34A", label: "json" },
  md:    { color: "#083FA1", label: "md" },
  yml:   { color: "#CB171E", label: "yml" },
  yaml:  { color: "#CB171E", label: "yml" },
  sh:    { color: "#89E051", label: "sh" },
  sql:   { color: "#E38C00", label: "sql" },
  vue:   { color: "#42B883", label: "vue" },
  svelte:{ color: "#FF3E00", label: "sv" },
  dart:  { color: "#00B4AB", label: "dart" },
  lua:   { color: "#6E7AB6", label: "lua" },
};

export default function FileIcon({ fileName, size = 18 }: Props) {
  const ext  = fileName.split(".").pop()?.toLowerCase() ?? "";
  const meta = EXT_META[ext];
  const color = meta?.color ?? "var(--vscode-descriptionForeground)";
  const label = meta?.label ?? (ext.slice(0, 4) || "file");

  return (
    <div style={{
      display:        "inline-flex",
      alignItems:     "center",
      justifyContent: "center",
      width:          size,
      height:         size,
      borderRadius:   3,
      background:     `${color}22`,
      border:         `1px solid ${color}66`,
      flexShrink:     0,
      overflow:       "hidden",
    }}>
      <span style={{
        fontSize:      label.length >= 4 ? 6 : label.length === 3 ? 7 : 8,
        fontWeight:    700,
        fontFamily:    "monospace",
        color:         color,
        lineHeight:    1,
        letterSpacing: "-0.5px",
        userSelect:    "none",
      }}>
        {label}
      </span>
    </div>
  );
}