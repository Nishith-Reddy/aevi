from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from services.llm import stream_completion
from services.rag import retrieve_context

router = APIRouter()


class ChatRequest(BaseModel):
    messages:       list[dict]
    workspace_path: str       = ""
    current_file:   str       = ""   # path of the active file
    current_code:   str       = ""   # full content of active file
    language:       str       = ""   # programming language
    model:          str | None = None


SYSTEM_PROMPT = """You are Telivi, an expert AI coding assistant built into VS Code.
You help developers with understanding, debugging, and improving code.

IMPORTANT RULES:
- When relevant code from the workspace is provided, always base your answer on that code
- Never make up or guess what code does — only describe what you can actually see
- Always use markdown code blocks when showing code
- Be concise and specific
- If you are not sure about something, say so clearly"""


@router.post("/chat")
async def chat(req: ChatRequest):
    """
    Streaming chat endpoint.
    Returns response as a text stream so words appear
    one by one in the UI — like ChatGPT.

    Example request:
        {
            "messages": [
                {"role": "user", "content": "explain the rag.py file"}
            ],
            "workspace_path": "/Users/you/myproject"
        }
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject current file as context directly into the first user message
    # Small local models follow user messages better than system prompts
    if req.current_code and req.current_file:
        lines     = req.current_code.splitlines()
        code      = "\n".join(lines[:200])
        truncated = len(lines) > 200
        lang      = req.language or "plaintext"
        fname     = req.current_file.split("/")[-1]

        # Get the last user message and prepend the file context to it
        augmented = list(req.messages)
        if augmented and augmented[-1]["role"] == "user":
            augmented[-1] = {
                "role": "user",
                "content": (
                    f"I have this file open (`{fname}`):\n\n"
                    f"```{lang}\n{code}\n```"
                    + ("\n\n[truncated]" if truncated else "")
                    + f"\n\nQuestion: {augmented[-1]['content']}"
                )
            }
        messages.extend(augmented)
    else:
        messages.extend(req.messages)

    async def generate():
        async for chunk in stream_completion(messages, model=req.model):
            yield chunk

    return StreamingResponse(generate(), media_type="text/plain")