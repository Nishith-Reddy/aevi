import json
import difflib
import os
import re
import tempfile
import asyncio
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from services.tools import read_file, write_file, edit_file, edit_lines, insert_lines, file_outline, list_dir, run_command, goto_line, find_in_file, write_plan, update_plan_step, cleanup_plan
from services.llm import _resolve_model
import litellm

router = APIRouter()

KNOWN_PREFIXES   = {"anthropic", "openai", "groq", "gemini", "ollama", "ollama_chat", "hosted_vllm", "meta-llama"}
ALWAYS_SUPPORTED = {"anthropic", "openai", "groq", "gemini"}


class AgentRequest(BaseModel):
    task:           str
    workspace_path: str
    model:          str | None = None
    resume_state:   dict | None = None


class ApplyRequest(BaseModel):
    path:    str
    content: str


class CleanupRequest(BaseModel):
    workspace_path: str


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_plan",
            "description": "Write your task plan to disk before doing any edits. Each step must have an id, desc, file, and status='pending'. You MUST call this before any edit tool.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace_path": {"type": "string"},
                    "task":           {"type": "string", "description": "The original user task"},
                    "steps": {
                        "type": "array",
                        "description": "List of steps: [{id, desc, file, status}]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id":     {"type": "integer"},
                                "desc":   {"type": "string"},
                                "file":   {"type": "string"},
                                "status": {"type": "string"},
                            },
                            "required": ["id", "desc", "file", "status"],
                        },
                    },
                },
                "required": ["workspace_path", "task", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan_step",
            "description": "After completing or skipping a step, mark it done/rejected/skipped in the plan file. Call this immediately after each edit is accepted.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace_path": {"type": "string"},
                    "step_id":        {"type": "integer", "description": "The step id to update"},
                    "status":         {"type": "string",  "enum": ["done", "rejected", "skipped"]},
                },
                "required": ["workspace_path", "step_id", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_outline",
            "description": (
                "Get a structural outline of a file — all classes, functions, and top-level "
                "declarations with their line numbers. Call this FIRST on any file over 200 lines "
                "before using find_in_file or read_file."
            ),
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file. Use start_line and end_line to read large files in chunks safely.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":       {"type": "string"},
                    "start_line": {"type": "integer"},
                    "end_line":   {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_lines",
            "description": "Replace a range of lines in a file using exact line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":        {"type": "string"},
                    "start_line":  {"type": "integer"},
                    "end_line":    {"type": "integer"},
                    "new_content": {"type": "string"},
                },
                "required": ["path", "start_line", "end_line", "new_content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_lines",
            "description": "Insert new content after a specific line number without replacing anything.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":       {"type": "string"},
                    "after_line": {"type": "integer"},
                    "content":    {"type": "string"},
                },
                "required": ["path", "after_line", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit an existing file by replacing a specific block of text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":         {"type": "string"},
                    "search_text":  {"type": "string"},
                    "replace_text": {"type": "string"},
                },
                "required": ["path", "search_text", "replace_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a brand new file or completely overwrite an extremely small file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "goto_line",
            "description": "Jump to a specific line number in a file and return surrounding context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string"},
                    "line":    {"type": "integer"},
                    "context": {"type": "integer"},
                },
                "required": ["path", "line"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_in_file",
            "description": "Search for anything in a file — function, class, variable, or any text/pattern.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string"},
                    "pattern": {"type": "string"},
                    "context": {"type": "integer"},
                },
                "required": ["path", "pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and folders in a directory",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a read-only shell command (grep, find, cat, ls)",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
]

TOOL_MAP = {
    "read_file":        read_file,
    "write_file":       write_file,
    "edit_file":        edit_file,
    "edit_lines":       edit_lines,
    "insert_lines":     insert_lines,
    "file_outline":     file_outline,
    "goto_line":        goto_line,
    "find_in_file":     find_in_file,
    "write_plan":       write_plan,
    "update_plan_step": update_plan_step,
    "list_dir":         list_dir,
    "run_command":      run_command,
}

SYSTEM_PROMPT = """You are Telivi, an autonomous coding agent inside VS Code.
Use the provided tools to complete tasks on the user's codebase.

WORKFLOW — FOLLOW THIS EXACTLY FOR EVERY TASK:

STEP 1 — WRITE PLAN (mandatory, before ANY other tool call):
  - Call `write_plan` with the workspace path, the user's task, and a numbered list of steps.
  - Each step must have: id (int), desc (string), file (string), status (always "pending" at creation).
  - Include ONLY steps the user explicitly asked for. No extra cleanup or improvements.

STEP 2 — EXECUTE (strict one-at-a-time):
  - Read the plan file to find the FIRST step with status="pending". Work on ONLY that step.
  - Locate it: use `goto_line` if the step has a line number, or `find_in_file` if it has a name.
  - To INSERT new content → use `insert_lines` with `after_line`.
  - To REPLACE existing content → use `edit_lines` with `start_line` and `end_line`.
  - NEVER use `edit_lines` for insertions.
  - STOP immediately after the edit. The user will accept or reject.
  - After acceptance, `update_plan_step` will be called. Then find the next pending step.
  - NEVER make more than one edit per step.

STEP 3 — VERIFY:
  - After all steps are done, use `find_in_file` to confirm changes applied correctly.
  - Declare the task complete. Do not make any changes not in the plan.

TOOL RULES:
1. ALWAYS use ABSOLUTE paths.
2. NEVER call `read_file` on a whole file. Use `file_outline` first on files > 200 lines, then `find_in_file`.
3. After `find_in_file` or `goto_line` returns line numbers, prefer `insert_lines` or `edit_lines`.
4. Only fall back to `edit_file` when you do not have line numbers.
5. Only use `write_file` for brand NEW files.
6. NEVER output code in markdown blocks. ALWAYS use the edit/write tools.
7. Do not stop until every step in the plan is done or the user has rejected all remaining steps.
"""

CONVERSATIONAL_PROMPT = """You are Telivi, a coding assistant embedded in VS Code.
You only help with coding tasks — reading, editing, refactoring, and understanding code.
If the user sends a greeting or small talk, respond with exactly one short sentence directing them to use the Chat feature.
Keep all responses short, direct, and professional. Never use tools."""

CASUAL_PATTERNS = re.compile(
    r'^\s*(hi|hello|hey|howdy|sup|whats up|how are you|good morning|good evening|'
    r'good afternoon|thanks|thank you|thx|ok|okay|cool|got it|bye|goodbye|'
    r'who are you|what are you|what can you do|help)\W*\s*$',
    re.IGNORECASE
)


def is_conversational(task: str) -> bool:
    stripped = task.strip()
    if len(stripped) < 60 and CASUAL_PATTERNS.match(stripped):
        return True
    if len(stripped) < 80 and not re.search(r'[/\\._]|def |class |import |\(\)', stripped):
        if len(stripped.split()) <= 8:
            return True
    return False


def make_diff(original: str, updated: str, filename: str) -> str:
    orig_lines    = original.splitlines(keepends=True)
    updated_lines = updated.splitlines(keepends=True)
    return "".join(difflib.unified_diff(
        orig_lines, updated_lines,
        fromfile=f"a/{filename}",
        tofile=f"b/{filename}",
        lineterm="",
    ))


def stream_event(event: str, data: dict) -> str:
    return json.dumps({"event": event, **data}) + "\n"


def get_model(requested: str | None) -> str:
    from routers.models import get_active_model
    m = requested or get_active_model()
    print(f"[agent] get_model: requested={requested!r} → {m!r}")
    return m


def _friendly_limit_message(err_str: str) -> str:
    low = err_str.lower()
    is_quota = any(k in low for k in ("daily", "quota", "exceeded your current", "resource_exhausted", "billing", "insufficient_quota"))
    if is_quota:
        return (
            "⛔ **Daily quota exhausted.** You've used up your free-tier or plan limit "
            "and cannot make more requests today. Please check your billing/quota at the "
            "provider dashboard, upgrade your plan, or switch to a different model."
        )
    return "⚠️ **Rate limit hit.** Too many requests per minute — please wait a moment and try again."


def _serialize_messages_for_api(messages: list[dict]) -> list[dict]:
    """Groq/OpenAI require tool_calls to have type='function' and arguments as a JSON string."""
    out = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            tcs = []
            for tc in msg["tool_calls"]:
                args = tc["function"]["arguments"]
                tcs.append({
                    "id":   tc.get("id", "call_0"),
                    "type": "function",
                    "function": {
                        "name":      tc["function"]["name"],
                        "arguments": json.dumps(args) if isinstance(args, dict) else (args or "{}"),
                    },
                })
            out.append({**msg, "tool_calls": tcs})
        else:
            out.append(msg)
    return out


async def _call_llm(model: str, messages: list[dict]) -> dict:
    """
    Call the appropriate backend and return a normalised message dict:
        { "role": "assistant", "content": "...", "tool_calls": [...] }

    Ollama uses direct HTTP (LiteLLM's ollama/ drops tool calls silently).
    All other providers go through LiteLLM with ollama_chat/ for local Ollama.
    """
    from config import settings

    prefix   = model.split("/")[0] if "/" in model else ""
    resolved = model if prefix in KNOWN_PREFIXES else _resolve_model(model)

    # ollama/ hits /api/generate (no tools); ollama_chat/ hits /api/chat (tools work)
    if resolved.startswith("ollama/"):
        resolved = resolved.replace("ollama/", "ollama_chat/", 1)

    print(f"[agent] _call_llm: model={model!r} → resolved={resolved!r}")

    kwargs: dict = dict(
        model=resolved,
        messages=_serialize_messages_for_api(messages),
        tools=TOOLS,
        stream=False,
        max_tokens=4096,
    )
    # tool_choice="auto" breaks some Ollama models; cloud APIs handle it fine
    if prefix not in ("ollama",):
        kwargs["tool_choice"] = "auto"

    response = await litellm.acompletion(**kwargs)
    msg     = response.choices[0].message
    content = msg.content or ""
    raw_tcs = msg.tool_calls or []

    tool_calls = []
    for tc in raw_tcs:
        args = tc.function.arguments
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        tool_calls.append({
            "id":       tc.id,
            "function": {"name": tc.function.name, "arguments": args},
        })

    return {"role": "assistant", "content": content, "tool_calls": tool_calls}


async def _call_llm_with_retry(model: str, messages: list[dict], max_retries: int = 3) -> dict:
    """Retry on transient rate limits. Re-raises immediately on quota exhaustion."""
    for attempt in range(max_retries):
        try:
            return await _call_llm(model, messages)
        except litellm.RateLimitError as e:
            err_str = str(e).lower()
            is_quota = any(k in err_str for k in ("daily", "quota", "exceeded your current", "resource_exhausted", "billing"))
            if is_quota or attempt >= max_retries - 1:
                raise
            delay = 60
            match = re.search(r'retry[^\d]*(\d+)', str(e), re.IGNORECASE)
            if match:
                delay = int(match.group(1)) + 2
            print(f"[agent] Rate limited. Retrying in {delay}s (attempt {attempt + 1}/{max_retries})...")
            await asyncio.sleep(delay)
    raise RuntimeError("Max retries exceeded")


async def supports_tools(model: str) -> bool:
    """Cloud APIs always support tools. Local models get a quick probe."""
    prefix = model.split("/")[0] if "/" in model else ""
    if prefix in ALWAYS_SUPPORTED:
        return True
    resolved = model if prefix in KNOWN_PREFIXES else _resolve_model(model)
    if resolved.startswith("ollama/"):
        resolved = resolved.replace("ollama/", "ollama_chat/", 1)
    print(f"[supports_tools] model={model!r} → resolved={resolved!r}")
    try:
        probe_kwargs: dict = dict(
            model=resolved,
            messages=[{"role": "user", "content": "hi"}],
            tools=TOOLS[:1],
            stream=False,
            max_tokens=10,
        )
        if prefix not in ("ollama",):
            probe_kwargs["tool_choice"] = "auto"
        response = await litellm.acompletion(**probe_kwargs)
        return response.choices[0].message is not None
    except Exception as e:
        err = str(e).lower()
        if "does not support tools" in err or "tool" in err:
            return False
        print(f"[supports_tools] non-tool error, assuming supported: {e}")
        return True


def parse_text_tool_call(text: str) -> list[dict]:
    triple_backtick = "`" * 3
    pattern = triple_backtick + r"(?:json)?\s*(\{.*?\})\s*" + triple_backtick
    json_matches = re.findall(pattern, text, re.DOTALL)
    extracted_tools = []
    for match in json_matches:
        try:
            data = json.loads(match)
            name, raw_args = None, {}
            if "function" in data:
                name     = data["function"].get("name")
                raw_args = data["function"].get("arguments", data["function"].get("parameters", {}))
            elif "name" in data:
                name     = data.get("name")
                raw_args = data.get("arguments", data.get("parameters", {}))
            if not name:
                continue
            if "properties" in raw_args and isinstance(raw_args["properties"], dict):
                args = raw_args["properties"]
            else:
                args = raw_args
            clean_args = {k: v for k, v in args.items()
                          if k not in ("type", "required", "properties") and not isinstance(v, dict)}
            extracted_tools.append({"id": data.get("id", "call_fallback"),
                                     "function": {"name": name, "arguments": clean_args}})
        except json.JSONDecodeError:
            continue
    return extracted_tools


def extract_search_hint(task: str) -> str:
    bt = re.findall(r'`([^`]+)`', task)
    if bt:
        return bt[0]
    qt = re.findall(r'["\']([^"\']{2,})["\']', task)
    if qt:
        return qt[0]
    tokens = re.findall(r'\b([A-Z][A-Z0-9_]{2,}|[a-z]+(?:_[a-z]+)+|[a-z][a-zA-Z0-9]{3,})\b', task)
    filler = {"from", "with", "this", "that", "then", "when", "where", "remove",
              "delete", "rename", "update", "change", "file", "function", "line"}
    tokens = [t for t in tokens if t.lower() not in filler]
    if tokens:
        return tokens[0]
    words = re.findall(r'\b\w{4,}\b', task)
    return words[0] if words else task.split()[0]


@router.post("/agent")
async def agent(req: AgentRequest):

    raw_task = req.task.strip()
    print(f"[agent] is_conversational({raw_task!r}) = {is_conversational(raw_task)}")

    if not req.resume_state and is_conversational(raw_task):
        model = get_model(req.model)

        async def reply():
            try:
                msg = await _call_llm_with_retry(model, [
                    {"role": "system", "content": CONVERSATIONAL_PROMPT},
                    {"role": "user",   "content": req.task},
                ])
                content = re.sub(r"<think>.*?</think>", "", msg["content"], flags=re.DOTALL).strip()
                yield stream_event("text", {"content": content})
                yield stream_event("done", {"summary": ""})
            except Exception as e:
                yield stream_event("error", {"message": str(e)})
                yield stream_event("done", {"summary": "Error."})

        return StreamingResponse(reply(), media_type="application/x-ndjson")

    model = get_model(req.model)

    if req.resume_state:
        messages   = req.resume_state["messages"]
        file_cache = req.resume_state["file_cache"]
    else:
        await cleanup_plan(req.workspace_path)
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": f"Workspace: {req.workspace_path}\n\nTask: {req.task}"},
        ]
        file_cache: dict[str, str] = {}

    async def run():
        try:
            has_tools = await supports_tools(model)
            if not has_tools:
                yield stream_event("text", {
                    "content": f"⚠️ `{model}` does not support tool calling.\n\nPlease switch to a model that supports tools using the model picker."
                })
                yield stream_event("done", {"summary": "Model does not support tools."})
                return

            plan_confirmed   = bool(req.resume_state)
            current_step_id: int | None = None

            for step in range(15):
                print(f"\n[agent] === STEP {step} ===")

                message = await _call_llm_with_retry(model, messages)

                print(f"\n========== STEP {step} RAW LLM OUTPUT ==========")
                print(message.get("content"))
                print(f"TOOL CALLS DETECTED: {message.get('tool_calls')}")
                print("================================================\n")

                tool_calls = message.get("tool_calls") or []
                content    = message.get("content") or ""

                thinking = ""
                think_match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
                if think_match:
                    thinking = think_match.group(1).strip()
                    content  = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

                if not tool_calls and content:
                    parsed = parse_text_tool_call(content)
                    if parsed:
                        print("[agent] Intercepted text-based tool call!")
                        tool_calls = parsed
                        triple_backtick = "`" * 3
                        pat = triple_backtick + r"(?:json)?\s*(\{.*?\})\s*" + triple_backtick
                        content = re.sub(pat, "", content, flags=re.DOTALL).strip()

                history_msg = {"role": message.get("role", "assistant"), "content": content}
                if tool_calls:
                    history_msg["tool_calls"] = tool_calls
                messages.append(history_msg)

                if step == 0 and not plan_confirmed:
                    has_plan = bool(re.search(r'^\s*\d+[\.\)]\s', content, re.MULTILINE))
                    if not tool_calls and not has_plan:
                        yield stream_event("text", {"content": content + "\n" if content else ""})
                        messages.append({
                            "role": "user",
                            "content": (
                                "Before doing anything, write a numbered plan listing every change needed: "
                                "file name, what to find, and what to do. Then start executing step 1."
                            )
                        })
                        continue
                    plan_confirmed = True

                if not tool_calls:
                    if content:
                        yield stream_event("text", {"content": content})
                        if "```" in content:
                            print("[agent] Model hallucinated markdown code. Forcing correction...")
                            yield stream_event("text", {"content": "\n\n*(Self-correcting: Forcing model to use tools...)*\n"})
                            messages.append({
                                "role": "user",
                                "content": "You provided code in plain text. You MUST use `insert_lines`, `edit_lines`, `edit_file`, or `write_file` to apply changes. Call the correct tool now."
                            })
                            continue
                        yield stream_event("done", {"summary": ""})
                        break

                    if not content.strip() and not thinking:
                        print("[agent] Model stalled. Nudging...")
                        yield stream_event("text", {"content": "\n\n*(Self-correcting: Model stalled, nudging to continue...)*\n"})
                        messages.append({
                            "role": "user",
                            "content": "You stopped without completing the task or calling a tool. Call the appropriate tool now to continue."
                        })
                        continue

                    if not content.strip() and thinking:
                        messages.append({
                            "role": "user",
                            "content": "You have finished reasoning. Now call the appropriate tool to carry out the task."
                        })
                        continue

                    yield stream_event("done", {"summary": ""})
                    break

                if content:
                    yield stream_event("text", {"content": content})

                for tc in tool_calls:
                    fn        = tc.get("function", {})
                    tool_name = fn.get("name", "")
                    tool_args = fn.get("arguments", {})

                    if tool_name not in TOOL_MAP:
                        continue

                    tmp_path = None
                    if tool_name in ("read_file", "goto_line", "find_in_file"):
                        fpath = tool_args.get("path", "")
                        if fpath in file_cache:
                            suffix = os.path.splitext(fpath)[1]
                            with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False, encoding="utf-8") as tmp:
                                tmp.write(file_cache[fpath])
                                tmp_path = tmp.name
                            tool_args = {**tool_args, "path": tmp_path}

                    if tool_name in ("find_in_file", "goto_line") and current_step_id is not None:
                        locate_calls = sum(
                            1 for m in messages
                            if m.get("role") == "assistant"
                            and any(
                                tc2.get("function", {}).get("name") in ("find_in_file", "goto_line")
                                for tc2 in (m.get("tool_calls") or [])
                            )
                        )
                        edit_calls = sum(
                            1 for m in messages
                            if m.get("role") == "tool"
                            and "[Staged]" in m.get("content", "")
                        )
                        if locate_calls > edit_calls + 1:
                            block_msg = (
                                f"[Blocked] You are looking ahead to future steps. "
                                f"Make the edit for step {current_step_id} now."
                            )
                            yield stream_event("tool_result", {"tool": tool_name, "result": block_msg})
                            messages.append({
                                "role": "tool", "content": block_msg,
                                **({"tool_call_id": tc["id"]} if tc.get("id") else {}),
                            })
                            if tmp_path:
                                try: os.unlink(tmp_path)
                                except Exception: pass
                            continue

                    if tool_name == "read_file" and "start_line" not in tool_args and "end_line" not in tool_args:
                        fpath = tool_args.get("path", "")
                        try:
                            size = os.path.getsize(fpath)
                        except Exception:
                            size = 0
                        if size > 3000:
                            hint = extract_search_hint(req.task)
                            correction = (
                                f"[Intercepted] File '{fpath}' is large ({size} bytes). "
                                f"Use `find_in_file` with pattern='{hint}' to locate the target first."
                            )
                            yield stream_event("tool_result", {"tool": tool_name, "result": correction})
                            messages.append({
                                "role": "tool", "content": correction,
                                **({"tool_call_id": tc["id"]} if tc.get("id") else {}),
                            })
                            if tmp_path:
                                try: os.unlink(tmp_path)
                                except Exception: pass
                            continue

                    yield stream_event("tool_call", {"tool": tool_name, "args": tool_args})

                    if tool_name in ("edit_lines", "edit_file", "write_file", "insert_lines") and current_step_id is not None:
                        pending_confirms = sum(
                            1 for m in messages
                            if m.get("role") == "tool" and "[Staged]" in m.get("content", "")
                        )
                        accepted_count = sum(
                            1 for m in messages
                            if m.get("role") == "tool" and "marked done" in m.get("content", "")
                        )
                        if pending_confirms > accepted_count:
                            block_msg = "[Blocked] You already have a staged edit waiting for user acceptance. Stop and wait."
                            yield stream_event("tool_result", {"tool": tool_name, "result": block_msg})
                            messages.append({
                                "role": "tool", "content": block_msg,
                                **({"tool_call_id": tc["id"]} if tc.get("id") else {}),
                            })
                            yield stream_event("done", {"summary": ""})
                            return

                    if tool_name == "update_plan_step" and not req.resume_state:
                        block_msg = "[Blocked] Do not mark a step done before the user accepts the edit."
                        yield stream_event("tool_result", {"tool": tool_name, "result": block_msg})
                        messages.append({
                            "role": "tool", "content": block_msg,
                            **({"tool_call_id": tc["id"]} if tc.get("id") else {}),
                        })
                        continue

                    if tool_name in ("write_file", "edit_file", "edit_lines", "insert_lines"):
                        fpath    = tool_args.get("path", "")
                        fname    = fpath.split("/")[-1]
                        # Always read from disk if not cached
                        if fpath not in file_cache:
                            disk = await read_file(fpath)
                            if not disk.startswith("[Error"):
                                file_cache[fpath] = disk
                        original = file_cache.get(fpath, "")

                        if tool_name == "write_file":
                            content_to_write = tool_args.get("content", "")

                        elif tool_name == "insert_lines":
                            after = tool_args.get("after_line", 0)
                            ins   = tool_args.get("content", "")
                            lines = original.splitlines(keepends=True)
                            total = len(lines)
                            if after < 0 or after > total:
                                err = f"[Error] after_line {after} out of bounds (file has {total} lines)."
                                yield stream_event("tool_result", {"tool": tool_name, "result": err})
                                tool_msg = {"role": "tool", "content": err}
                                if tc.get("id"): tool_msg["tool_call_id"] = tc["id"]
                                messages.append(tool_msg)
                                continue
                            insertion        = ins if ins.endswith("\n") else ins + "\n"
                            content_to_write = "".join(lines[:after] + [insertion] + lines[after:])

                        elif tool_name == "edit_lines":
                            start = tool_args.get("start_line", 1)
                            end   = tool_args.get("end_line", 1)
                            new_c = tool_args.get("new_content", "")
                            lines = original.splitlines(keepends=True)
                            total = len(lines)
                            if start < 1 or end > total or start > end:
                                err = f"[Error] Line range {start}-{end} out of bounds (file has {total} lines)."
                                yield stream_event("tool_result", {"tool": tool_name, "result": err})
                                tool_msg = {"role": "tool", "content": err}
                                if tc.get("id"): tool_msg["tool_call_id"] = tc["id"]
                                messages.append(tool_msg)
                                continue
                            replacement      = new_c if (not new_c or new_c.endswith("\n")) else new_c + "\n"
                            content_to_write = "".join(lines[:start - 1] + ([replacement] if replacement else []) + lines[end:])

                        else:  # edit_file
                            search_text  = tool_args.get("search_text", "")
                            replace_text = tool_args.get("replace_text", "")
                            if search_text not in original:
                                err = "[Error] search_text not found. Match exactly including whitespace."
                                yield stream_event("tool_result", {"tool": tool_name, "result": err})
                                tool_msg = {"role": "tool", "content": err}
                                if tc.get("id"): tool_msg["tool_call_id"] = tc["id"]
                                messages.append(tool_msg)
                                continue
                            content_to_write = original.replace(search_text, replace_text, 1)

                        diff              = make_diff(original, content_to_write, fname)
                        file_cache[fpath] = content_to_write

                        staged_msg = {"role": "tool", "content": f"[Staged] {tool_name} on '{fname}' ready for review."}
                        if tc.get("id"): staged_msg["tool_call_id"] = tc["id"]
                        messages.append(staged_msg)

                        yield stream_event("confirm_write", {
                            "path":             fpath,
                            "content_to_write": content_to_write,
                            "diff":             diff,
                            "fname":            fname,
                            "resume_state":     {"messages": messages, "file_cache": file_cache},
                        })
                        return

                    try:
                        result = await TOOL_MAP[tool_name](**tool_args)
                    except TypeError as e:
                        result = f"[Error] Invalid arguments for {tool_name}: {e}"
                    except Exception as e:
                        result = f"[Error] Execution failed: {e}"
                    finally:
                        if tmp_path:
                            try: os.unlink(tmp_path)
                            except Exception: pass

                    if tool_name == "write_plan" and not result.startswith("[Error"):
                        current_step_id = 1

                    if tool_name == "update_plan_step" and not result.startswith("[Error"):
                        completed       = tool_args.get("step_id", 0)
                        current_step_id = completed + 1
                        if "0 steps remaining" in result:
                            await cleanup_plan(req.workspace_path)
                            yield stream_event("tool_result", {"tool": tool_name, "result": result[:500]})
                            messages.append({"role": "tool", "content": str(result),
                                             **({"tool_call_id": tc["id"]} if tc.get("id") else {})})
                            yield stream_event("done", {"summary": ""})
                            return

                    if tool_name == "read_file" and "start_line" not in tool_args and "end_line" not in tool_args and not result.startswith("[Error"):
                        file_cache[tool_args.get("path", "")] = result

                    yield stream_event("tool_result", {"tool": tool_name, "result": result[:500]})

                    tool_msg = {"role": "tool", "content": str(result)}
                    if tc.get("id"): tool_msg["tool_call_id"] = tc["id"]
                    messages.append(tool_msg)

                    if tool_name in ("find_in_file", "goto_line") and not result.startswith(("[Error", "[No matches")):
                        messages.append({
                            "role": "user",
                            "content": "Good. Use the line numbers above with `insert_lines` or `edit_lines` to make your change now."
                        })

            else:
                yield stream_event("done", {"summary": "Reached maximum steps."})

        except litellm.RateLimitError as e:
            err_str = str(e)
            print(f"[agent] Rate limit: {err_str}")
            yield stream_event("text", {"content": f"\n\n{_friendly_limit_message(err_str)}\n\n_{err_str[:300]}_"})
            yield stream_event("done", {"summary": "Rate limited."})
        except litellm.AuthenticationError as e:
            print(f"[agent] Auth error: {e}")
            yield stream_event("text", {"content": f"\n\n⚠️ **Authentication failed.** Check your API key in Settings.\n\n_{str(e)[:200]}_"})
            yield stream_event("done", {"summary": "Auth error."})
        except litellm.BadRequestError as e:
            print(f"[agent] Bad request: {e}")
            yield stream_event("text", {"content": f"\n\n⚠️ **Bad request error.**\n\n_{str(e)[:300]}_"})
            yield stream_event("done", {"summary": "Bad request."})
        except Exception as e:
            print(f"[agent] EXCEPTION: {e}")
            yield stream_event("error", {"message": str(e)})
            yield stream_event("done", {"summary": "Error."})

    return StreamingResponse(run(), media_type="application/x-ndjson")


@router.post("/agent/apply")
async def apply_changes(req: ApplyRequest):
    result = await write_file(req.path, req.content)
    return {"status": "applied", "path": req.path, "result": result}


@router.post("/agent/cleanup-plan")
async def cleanup_plan_endpoint(req: CleanupRequest):
    result = await cleanup_plan(req.workspace_path)
    return {"status": "ok", "result": result}