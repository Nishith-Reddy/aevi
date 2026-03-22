import json
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from services.llm import complete
from services.tools import read_file, write_file, list_dir, run_command

router = APIRouter()


class AgentRequest(BaseModel):
    task:           str        # what the user wants done
    workspace_path: str        # root of the project
    model:          str | None = None


# Tools the agent can call
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to the file"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file. Always read the file first before writing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path":    {"type": "string", "description": "Absolute path to the file"},
                    "content": {"type": "string", "description": "Full content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List all files and folders in a directory",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to the directory"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a read-only shell command (grep, cat, ls, find, etc.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run"}
                },
                "required": ["command"],
            },
        },
    },
]

# Map tool names to actual functions
TOOL_MAP = {
    "read_file":   read_file,
    "write_file":  write_file,
    "list_dir":    list_dir,
    "run_command": run_command,
}

SYSTEM_PROMPT = """You are Telivi, an autonomous coding agent.
You have access to tools to read, write, and explore a codebase.

Your workflow:
1. list_dir to understand the project structure
2. read_file to read relevant files before making changes
3. write_file to apply changes
4. run_command to verify your changes (e.g. grep, cat)

Rules:
- Always read a file before writing it
- Make minimal, focused changes
- Explain what you're doing at each step
- If a task is unclear, explain what you would need to proceed"""


@router.post("/agent")
async def agent(req: AgentRequest):
    """
    Agentic task runner.
    The model runs in a loop — calling tools until the task is complete.

    Example request:
        {
            "task": "add docstrings to all functions in utils.py",
            "workspace_path": "/Users/you/myproject"
        }
    """
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Workspace: {req.workspace_path}\n\nTask: {req.task}"
        },
    ]

    async def run():
        # Max 10 iterations to prevent infinite loops
        for step in range(10):
            response = await complete(
                messages=messages,
                model=req.model,
                max_tokens=1024,
            )

            # Stream the model's thinking to the UI
            yield f"{response}\n"

            # Check if the model wants to call a tool
            # Full tool-calling loop will be implemented in Phase 6
            # For now, yield the response and stop
            # This gives us a working agent foundation to build on
            if not response.strip():
                break

            # Add assistant response to history
            messages.append({"role": "assistant", "content": response})

            # Stop if model signals task is complete
            stop_signals = ["task complete", "done", "finished", "no further"]
            if any(s in response.lower() for s in stop_signals):
                yield "[Telivi] Task complete.\n"
                break

        else:
            yield "[Telivi] Reached maximum steps.\n"

    return StreamingResponse(run(), media_type="text/plain")