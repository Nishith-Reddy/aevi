from fastapi import APIRouter
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import numpy as np
import litellm

from services.llm import stream_completion
from services.rag import _embed_model

router = APIRouter()

class ChatRequest(BaseModel):
    messages:       list[dict]
    workspace_path: str       = ""
    current_file:   str       = ""
    current_code:   str       = ""
    language:       str       = ""
    model:          str | None = None

SYSTEM_PROMPT = """You are aevi, an expert AI coding assistant built into VS Code.
You help developers with understanding, debugging, and improving code.

IMPORTANT RULES:
- When relevant code from the workspace is provided, always base your answer on that code
- Never make up or guess what code does — only describe what you can actually see
- Always use markdown code blocks when showing code
- Be concise and specific
- If you are not sure about something, say so clearly"""


def cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    v1 = np.array(vec1)
    v2 = np.array(vec2)
    if np.linalg.norm(v1) == 0 or np.linalg.norm(v2) == 0:
        return 0.0
    return float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))


def optimize_chat_history(messages: list[dict], similarity_threshold: float = 0.35, max_lookback: int = 3) -> list[dict]:
    turns = []
    current_turn = []
    for msg in messages:
        if msg["role"] == "user":
            if current_turn:
                turns.append(current_turn)
            current_turn = [msg]
        else:
            if current_turn:
                current_turn.append(msg)
    if current_turn:
        turns.append(current_turn)

    if len(turns) < 2:
        return messages

    newest_turn  = turns[-1]
    newest_query = newest_turn[0]["content"]
    new_vec      = _embed_model.encode(newest_query).tolist()
    turns_to_check = turns[:-1][-max_lookback:]

    stitched_history = []
    for turn in turns_to_check:
        prev_query = turn[0]["content"]
        prev_vec   = _embed_model.encode(prev_query).tolist()
        similarity = cosine_similarity(new_vec, prev_vec)
        if similarity >= similarity_threshold:
            stitched_history.extend(turn)

    stitched_history.extend(newest_turn)

    if len(stitched_history) > 10:
        stitched_history = stitched_history[-10:]

    return stitched_history


def _friendly_limit_message(err_str: str) -> str:
    """Return a user-facing message distinguishing daily quota from per-minute throttle."""
    low = err_str.lower()
    is_quota = any(k in low for k in ("daily", "quota", "exceeded your current", "resource_exhausted", "billing", "insufficient_quota"))
    if is_quota:
        return (
            "⛔ **Daily quota exhausted.** You've used up your free-tier or plan limit "
            "and cannot make more requests today. Please check your billing/quota at the "
            "provider dashboard, upgrade your plan, or switch to a different model."
        )
    return "⚠️ **Rate limit hit.** Too many requests per minute — please wait a moment and try again."


@router.post("/chat")
async def chat(req: ChatRequest):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    optimized_history = optimize_chat_history(req.messages)

    if req.current_code and req.current_file:
        lines     = req.current_code.splitlines()
        code      = "\n".join(lines[:200])
        truncated = len(lines) > 200
        lang      = req.language or "plaintext"
        fname     = req.current_file.split("/")[-1]

        if optimized_history and optimized_history[-1]["role"] == "user":
            optimized_history[-1] = {
                "role": "user",
                "content": (
                    f"I have this file open (`{fname}`):\n\n"
                    f"```{lang}\n{code}\n```"
                    + ("\n\n[truncated]" if truncated else "")
                    + f"\n\nQuestion: {optimized_history[-1]['content']}"
                )
            }

    messages.extend(optimized_history)

    async def generate():
        try:
            async for chunk in stream_completion(messages, model=req.model):
                yield chunk
        except litellm.RateLimitError as e:
            yield f"\n\n{_friendly_limit_message(str(e))}\n\n_{str(e)[:300]}_"
        except litellm.AuthenticationError as e:
            yield f"\n\n⚠️ **Authentication failed.** Check your API key in Settings.\n\n_{str(e)[:200]}_"
        except litellm.BadRequestError as e:
            yield f"\n\n⚠️ **Bad request error.**\n\n_{str(e)[:300]}_"
        except Exception as e:
            yield f"\n\n⚠️ **Unexpected error:** {str(e)[:300]}"

    return StreamingResponse(generate(), media_type="text/plain")