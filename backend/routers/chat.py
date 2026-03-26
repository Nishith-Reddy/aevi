from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import numpy as np

from services.llm import stream_completion
# Import your existing embedding model from rag.py so we don't load it twice!
from services.rag import _embed_model 

router = APIRouter()

class ChatRequest(BaseModel):
    messages:       list[dict]
    workspace_path: str       = ""
    current_file:   str       = ""   
    current_code:   str       = ""   
    language:       str       = ""   
    model:          str | None = None

SYSTEM_PROMPT = """You are Telivi, an expert AI coding assistant built into VS Code.
You help developers with understanding, debugging, and improving code.

IMPORTANT RULES:
- When relevant code from the workspace is provided, always base your answer on that code
- Never make up or guess what code does — only describe what you can actually see
- Always use markdown code blocks when showing code
- Be concise and specific
- If you are not sure about something, say so clearly"""


def cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """Calculate the cosine similarity between two vectors."""
    v1 = np.array(vec1)
    v2 = np.array(vec2)
    # Prevent division by zero just in case
    if np.linalg.norm(v1) == 0 or np.linalg.norm(v2) == 0:
        return 0.0
    return float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))


def optimize_chat_history(messages: list[dict], similarity_threshold: float = 0.35, max_lookback: int = 3) -> list[dict]:
    """
    Advanced Memory Bouncer with Context Stitching.
    1. Groups messages into conversation "Turns".
    2. Scans up to `max_lookback` previous turns for relevance.
    3. Stitches relevant history together, dropping unrelated interruptions.
    """
    # 1. Group the chat into "Turns" (User message + all subsequent Assistant messages)
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

    # If this is the first question, just return it
    if len(turns) < 2:
        return messages

    # 2. Extract the newest turn (our target for comparison)
    newest_turn = turns[-1]
    newest_query = newest_turn[0]["content"]
    new_vec = _embed_model.encode(newest_query).tolist()
    
    # 3. Lookback only at the last `max_lookback` previous turns to save compute time
    previous_turns = turns[:-1]
    turns_to_check = previous_turns[-max_lookback:]
    
    stitched_history = []
    print(f"\n[Memory Manager] Analyzing last {len(turns_to_check)} user turns for context stitching...")
    
    # 4. Evaluate each historical turn
    for turn in turns_to_check:
        prev_query = turn[0]["content"]
        prev_vec = _embed_model.encode(prev_query).tolist()
        similarity = cosine_similarity(new_vec, prev_vec)
        
        # If the old turn is relevant to the new question, stitch it in!
        if similarity >= similarity_threshold:
            print(f"  ✅ Keeping relevant turn (Similarity: {similarity:.2f}): '{prev_query[:30]}...'")
            stitched_history.extend(turn)
        else:
            print(f"  🛑 Dropping unrelated turn (Similarity: {similarity:.2f}): '{prev_query[:30]}...'")
            
    # 5. Always append the newest turn at the end
    stitched_history.extend(newest_turn)
    
    # 6. Apply a final hard cap (e.g., max 10 messages = 5 pairs) to guarantee token safety
    if len(stitched_history) > 10:
        stitched_history = stitched_history[-10:]
        
    return stitched_history

@router.post("/chat")
async def chat(req: ChatRequest):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # 1. OPTIMIZE THE HISTORY FIRST (Filters the array before the LLM ever sees it)
    optimized_history = optimize_chat_history(req.messages)

    # 2. INJECT FILE CONTEXT (Into the optimized array)
    if req.current_code and req.current_file:
        lines     = req.current_code.splitlines()
        code      = "\n".join(lines[:200])
        truncated = len(lines) > 200
        lang      = req.language or "plaintext"
        fname     = req.current_file.split("/")[-1]

        # Prepend the file context strictly to the LAST message in the optimized history
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
        async for chunk in stream_completion(messages, model=req.model):
            yield chunk

    return StreamingResponse(generate(), media_type="text/plain")