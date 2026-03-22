from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from services.llm import stream_completion
from services.rag import retrieve_context

router = APIRouter()


class ChatRequest(BaseModel):
    messages:       list[dict]       # full conversation history [{role, content}]
    workspace_path: str      = ""    # if set, RAG context is injected
    model:          str | None = None


SYSTEM_PROMPT = """You are Telivi, an expert AI coding assistant built into VS Code.
You help developers with:
- Understanding and explaining code
- Debugging and fixing errors
- Refactoring and improving code quality
- Writing tests and documentation
- Answering technical questions

Guidelines:
- Be concise and direct
- Always use markdown code blocks when showing code
- If you're unsure about something, say so
- Reference specific files or line numbers when relevant"""


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

    # Inject RAG context if workspace is provided
    if req.workspace_path and req.messages:
        # Get the last user message to use as the search query
        last_user_msg = next(
            (m["content"] for m in reversed(req.messages) if m["role"] == "user"),
            ""
        )

        context = await retrieve_context(last_user_msg, req.workspace_path)

        if context:
            messages.append({
                "role": "system",
                "content": (
                    "Here is relevant code from the user's workspace. "
                    "Use it to give accurate, specific answers:\n\n"
                    f"{context}"
                )
            })

    # Add the full conversation history
    messages.extend(req.messages)

    async def generate():
        async for chunk in stream_completion(messages, model=req.model):
            yield chunk

    return StreamingResponse(generate(), media_type="text/plain")