import json
import difflib
import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from services.tools import read_file, write_file, list_dir, run_command
from config import settings

router = APIRouter()


class AgentRequest(BaseModel):
    task:           str
    workspace_path: str
    model:          str | None = None


class ApplyRequest(BaseModel):
    path:    str
    content: str


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file",
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
            "name": "write_file",
            "description": "Write content to a file — requires user confirmation",
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
    "read_file":   read_file,
    "write_file":  write_file,
    "list_dir":    list_dir,
    "run_command": run_command,
}

SYSTEM_PROMPT = """You are Telivi, an autonomous coding agent inside VS Code.
Use the provided tools to complete tasks on the user's codebase.

IMPORTANT:
- The workspace root path is provided at the start of every task
- Always use ABSOLUTE paths when calling tools — never relative paths
- Always use tools to get real information — never guess or make up file contents
- Read files before editing them
- Explain what you are doing at each step
- When using grep or find, always exclude these directories: .venv, node_modules, __pycache__, .git, dist, build
  Example: grep -r "pattern" /path --include="*.py" --exclude-dir=.venv --exclude-dir=node_modules"""


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
    return requested or get_active_model()


async def supports_tools(client: httpx.AsyncClient, model: str) -> bool:
    """Check if a model supports native tool calling."""
    try:
        resp = await client.post(
            f"{settings.ollama_base_url}/api/chat",
            json={
                "model":    model,
                "messages": [{"role": "user", "content": "hi"}],
                "tools":    TOOLS[:1],
                "stream":   False,
            },
            timeout=120.0,  # increased — model may need time to load
        )
        print(f"[supports_tools] status={resp.status_code} body={resp.text[:200]}")
        if resp.status_code == 400 and "does not support tools" in resp.text:
            return False
        return resp.is_success
    except Exception as e:
        print(f"[supports_tools] exception: {e}")
        return False


@router.post("/agent")
async def agent(req: AgentRequest):
    model        = get_model(req.model)
    ollama_model = model.replace("ollama/", "").strip()
    messages     = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": f"Workspace: {req.workspace_path}\n\nTask: {req.task}"},
    ]
    file_cache: dict[str, str] = {}

    async def run():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:

                # Check tool support
                has_tools = await supports_tools(client, ollama_model)
                print(f"[agent] model={ollama_model} supports_tools={has_tools}")

                if not has_tools:
                    yield stream_event("text", {
                        "content": f"⚠️ `{ollama_model}` does not support tool calling.\n\nPlease switch to a model that supports tools (e.g. `qwen3.5:9b`) using the model picker."
                    })
                    yield stream_event("done", {"summary": "Model does not support tools."})
                    return

                for step in range(15):
                    print(f"[agent] step={step}")
                    resp = await client.post(
                        f"{settings.ollama_base_url}/api/chat",
                        json={
                            "model":    ollama_model,
                            "messages": messages,
                            "tools":    TOOLS,
                            "stream":   False,
                        }
                    )
                    print(f"[agent] status={resp.status_code}")
                    if not resp.is_success:
                        print(f"[agent] error={resp.text[:300]}")
                    resp.raise_for_status()

                    data       = resp.json()
                    message    = data.get("message", {})
                    tool_calls = message.get("tool_calls", [])
                    content    = message.get("content", "")

                    # Add to history — strip thinking field
                    history_msg = {
                        "role":    message.get("role", "assistant"),
                        "content": content,
                    }
                    if tool_calls:
                        history_msg["tool_calls"] = tool_calls
                    messages.append(history_msg)

                    if not tool_calls:
                        if content:
                            yield stream_event("text", {"content": content})
                        yield stream_event("done", {"summary": ""})  # summary already in text
                        break

                    if content:
                        yield stream_event("text", {"content": content})

                    for tc in tool_calls:
                        fn        = tc.get("function", {})
                        tool_name = fn.get("name", "")
                        tool_args = fn.get("arguments", {})

                        if tool_name not in TOOL_MAP:
                            continue

                        yield stream_event("tool_call", {"tool": tool_name, "args": tool_args})

                        if tool_name == "write_file":
                            fpath            = tool_args.get("path", "")
                            content_to_write = tool_args.get("content", "")
                            fname            = fpath.split("/")[-1]
                            original         = file_cache.get(fpath, "")
                            if not original:
                                original = await read_file(fpath)
                                if original.startswith("[Error"):
                                    original = ""
                            diff = make_diff(original, content_to_write, fname)
                            yield stream_event("confirm_write", {
                                "path":             fpath,
                                "content_to_write": content_to_write,
                                "diff":             diff,
                                "fname":            fname,
                            })
                            messages.append({
                                "role":         "tool",
                                "content":      "[PENDING] write_file awaiting confirmation",
                                "tool_call_id": tc.get("id", ""),
                            })
                            return

                        result = await TOOL_MAP[tool_name](**tool_args)
                        if tool_name == "read_file":
                            file_cache[tool_args.get("path", "")] = result

                        yield stream_event("tool_result", {"tool": tool_name, "result": result[:500]})
                        messages.append({
                            "role":         "tool",
                            "content":      result,
                            "tool_call_id": tc.get("id", ""),
                        })

                else:
                    yield stream_event("done", {"summary": "Reached maximum steps."})

        except Exception as e:
            print(f"[agent] EXCEPTION: {e}")
            yield stream_event("error", {"message": str(e)})

    return StreamingResponse(run(), media_type="application/x-ndjson")


@router.post("/agent/apply")
async def apply_changes(req: ApplyRequest):
    result = await write_file(req.path, req.content)
    return {"status": "applied", "path": req.path, "result": result}