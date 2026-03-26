"""
Agent tool correctness evaluation.

Metrics:
- Tool selection accuracy: did it call the right tool?
- Path accuracy: did it use the correct file/directory path?
- Result accuracy: did the result contain expected content?
- Task success rate: overall % of tasks completed correctly
"""
import json
import os
import sys
import asyncio
import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

BACKEND_URL  = "http://127.0.0.1:8765"
DATASETS_DIR = os.path.join(os.path.dirname(__file__), "datasets")


async def run_agent_task(task: str, workspace_path: str) -> list[dict]:
    """Run an agent task and collect all events."""
    events = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{BACKEND_URL}/api/agent",
            json={"task": task, "workspace_path": workspace_path},
        ) as resp:
            async for line in resp.aiter_lines():
                if line.strip():
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    return events


def load_test_cases():
    with open(os.path.join(DATASETS_DIR, "agent_tests.json")) as f:
        return json.load(f)


@pytest.mark.asyncio
@pytest.mark.parametrize("test_case", load_test_cases(), ids=[t["id"] for t in load_test_cases()])
async def test_agent_tool_correctness(test_case: dict):
    """Test that the agent calls the right tools with correct arguments."""
    events = await run_agent_task(
        task=f"Workspace root: {test_case['workspace_path']}\n\n{test_case['task']}",
        workspace_path=test_case["workspace_path"],
    )

    # Extract tool calls and results
    tool_calls  = [e for e in events if e.get("event") == "tool_call"]
    tool_results = [e for e in events if e.get("event") == "tool_result"]
    errors      = [e for e in events if e.get("event") == "error"]

    print(f"\n[{test_case['id']}] events: {[e.get('event') for e in events]}")
    print(f"[{test_case['id']}] tool_calls: {[(t.get('tool'), t.get('args')) for t in tool_calls]}")

    # 1. No errors
    assert not errors, f"Agent produced errors: {errors}"

    # 2. At least one tool was called
    assert tool_calls, "Agent made no tool calls — likely hallucinated"

    # 3. Correct tool was called
    tools_used = [t.get("tool") for t in tool_calls]
    assert test_case["expected_tool"] in tools_used, \
        f"Expected tool '{test_case['expected_tool']}' not called. Used: {tools_used}"

    # 4. Path contains expected substring
    for tc in tool_calls:
        if tc.get("tool") == test_case["expected_tool"]:
            args = tc.get("args", {})
            path_arg = args.get("path", "") or args.get("command", "")
            assert test_case["expected_path_contains"].lower() in path_arg.lower(), \
                f"Expected path to contain '{test_case['expected_path_contains']}', got '{path_arg}'"

    # 5. Result contains expected content
    all_results = " ".join(r.get("result", "") for r in tool_results)
    missing = [
        item for item in test_case["expected_result_contains"]
        if item.lower() not in all_results.lower()
    ]
    assert not missing, f"Missing expected content in results: {missing}"

    print(f"[{test_case['id']}] ✅ PASSED")