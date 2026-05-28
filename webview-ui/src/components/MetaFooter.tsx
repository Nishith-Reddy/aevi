export interface MessageMeta {
  total_tokens?:      number;
  prompt_tokens?:     number;
  completion_tokens?: number;
  elapsed_ms?:        number;
}

export default function MetaFooter({ meta }: { meta: MessageMeta }) {
  const tokens =
    meta.total_tokens ??
    (meta.prompt_tokens ?? 0) + (meta.completion_tokens ?? 0);
  const seconds =
    typeof meta.elapsed_ms === "number" ? meta.elapsed_ms / 1000 : null;
  if (!tokens && seconds === null) return null;

  const parts: string[] = [];
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
  if (seconds !== null) parts.push(`${seconds.toFixed(2)}s`);
  return <div className="msg-meta">{parts.join(" · ")}</div>;
}
