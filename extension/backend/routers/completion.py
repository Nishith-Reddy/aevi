from fastapi import APIRouter
from pydantic import BaseModel
from services.llm import complete
from config import settings

router = APIRouter()


class CompletionRequest(BaseModel):
    prefix:   str            # code before the cursor
    suffix:   str  = ""      # code after the cursor
    language: str  = ""      # e.g. "python", "typescript"
    model:    str | None = None  # override default model


# System prompt — tells the LLM to return raw code only
SYSTEM_PROMPT = """You are a code completion engine.
Complete the code at the cursor. Return ONLY the completion text — no explanations, no markdown, no backticks.
Even if the completion is just one word or one line, return it.
Never return empty — always suggest something reasonable."""


def strip_markdown(text: str) -> str:
    """Remove markdown code blocks and HTML tags the model sometimes adds."""
    import re
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        # skip markdown fences like ```python, ```ts, ```
        if line.strip().startswith("```"):
            continue
        cleaned.append(line)
    result = "\n".join(cleaned).strip()
    # strip any HTML tags like <A>, </A>, <PREFIX>, <SUFFIX>
    result = re.sub(r"<[^>]+>", "", result).strip()
    return result


def remove_prefix_echo(completion: str, prefix: str) -> str:
    """
    If the model echoed back the prefix, strip it out.
    We only want the NEW code to insert at the cursor.
    """
    # Get the last line of the prefix (what's on the current line)
    last_prefix_line = prefix.splitlines()[-1] if prefix.splitlines() else ""

    # If completion starts with the full prefix, strip it
    if completion.startswith(prefix):
        completion = completion[len(prefix):]

    # If completion starts with the current line content, strip it
    elif last_prefix_line and completion.startswith(last_prefix_line):
        completion = completion[len(last_prefix_line):]

    return completion.strip()


@router.post("/complete")
async def inline_complete(req: CompletionRequest):
    """
    Inline code completion endpoint.
    Called by the VS Code extension on every keypress (debounced).

    Example request:
        {
            "prefix": "def add(a, b):\n    return",
            "suffix": "",
            "language": "python"
        }

    Example response:
        {
            "completion": " a + b"
        }
    """
    lang = f"Language: {req.language}\n" if req.language else ""

    prompt = (
        f"{lang}"
        f"<PREFIX>\n{req.prefix}\n</PREFIX>\n"
        f"<SUFFIX>\n{req.suffix}\n</SUFFIX>\n"
        f"Complete the code at the cursor. Return only the inserted code:"
    )

    result = await complete(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        model=req.model,  # None = uses active model from model picker
        max_tokens=256,
    )

    # Clean up the result
    result = strip_markdown(result)
    result = remove_prefix_echo(result, req.prefix)

    return {"completion": result}