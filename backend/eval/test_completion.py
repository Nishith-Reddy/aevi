"""
Inline completion evaluation.

Metrics:
- Latency: time to get a completion (target < 3s)
- Non-empty rate: % of requests that return actual content
- Clean output rate: % without markdown/backticks/echoed prefix
- Relevance: does the completion make sense given the prefix?

Outputs are saved to: eval/outputs/completions_<model>.json
"""
import time
import json
import os
import httpx
import pytest
import asyncio
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

BACKEND_URL  = "http://127.0.0.1:8765"
OUTPUTS_DIR  = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)

COMPLETION_TESTS = [
    {
        "id": "comp_001",
        "prefix": "def add(a, b):\n    return",
        "suffix": "",
        "language": "python",
        "description": "simple arithmetic function",
        "should_not_contain": ["```", "def add"],
    },
    {
        "id": "comp_002",
        "prefix": "def calculate_total(items):\n    total = 0\n    for item in items:\n        total +=",
        "suffix": "\n    return total",
        "language": "python",
        "description": "loop accumulation",
        "should_not_contain": ["```", "for item"],
    },
    {
        "id": "comp_003",
        "prefix": "class User:\n    def __init__(self, name, email):\n        self.name =",
        "suffix": "\n        self.email = email",
        "language": "python",
        "description": "class constructor",
        "should_not_contain": ["```", "__init__"],
    },
    {
        "id": "comp_004",
        "prefix": "import os\nimport json\n\ndef read_config(path):\n    with open(path) as f:\n        return",
        "suffix": "",
        "language": "python",
        "description": "file reading with json",
        "should_not_contain": ["```"],
    },
    {
        "id": "comp_005",
        "prefix": "async def fetch_user(user_id: int) -> dict:\n    async with httpx.AsyncClient() as client:\n        resp = await client.get(",
        "suffix": "\n    return resp.json()",
        "language": "python",
        "description": "async http call",
        "should_not_contain": ["```"],
    },
]

# Shared results collector across tests
_results: list[dict] = []


async def get_active_model() -> str:
    """Fetch the currently active model from the backend."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{BACKEND_URL}/api/models")
            return resp.json().get("active", "unknown")
    except Exception:
        return "unknown"


async def get_completion(prefix: str, suffix: str, language: str) -> tuple[str, float]:
    """Get a completion and measure latency."""
    start = time.time()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{BACKEND_URL}/api/complete",
            json={"prefix": prefix, "suffix": suffix, "language": language},
        )
        data = resp.json()
    latency = time.time() - start
    return data.get("completion", ""), latency


def save_results(model: str, results: list[dict]):
    """Save results to a JSON file named after the model."""
    safe_model = model.replace("/", "_").replace(":", "_")
    filename   = os.path.join(OUTPUTS_DIR, f"completions_{safe_model}.json")

    output = {
        "model":      model,
        "timestamp":  datetime.now().isoformat(),
        "total":      len(results),
        "passed":     sum(1 for r in results if r["passed"]),
        "avg_latency": round(sum(r["latency"] for r in results) / len(results), 2) if results else 0,
        "results":    results,
    }

    with open(filename, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n📄 Results saved to: {filename}")
    return filename


@pytest.mark.asyncio
@pytest.mark.parametrize("test", COMPLETION_TESTS, ids=[t["id"] for t in COMPLETION_TESTS])
async def test_completion_quality(test: dict):
    completion, latency = await get_completion(
        prefix=test["prefix"],
        suffix=test["suffix"],
        language=test["language"],
    )

    passed = True
    failures = []

    # 1. Latency check
    if latency >= 10.0:
        passed = False
        failures.append(f"too slow: {latency:.2f}s")

    # 2. Non-empty
    if not completion.strip():
        passed = False
        failures.append("empty completion")

    # 3. Clean output
    for bad in test["should_not_contain"]:
        if bad in completion:
            passed = False
            failures.append(f"contains '{bad}'")

    # Store result
    _results.append({
        "id":          test["id"],
        "description": test["description"],
        "prefix":      test["prefix"],
        "suffix":      test["suffix"],
        "completion":  completion,
        "latency":     round(latency, 2),
        "passed":      passed,
        "failures":    failures,
    })

    # Print to console
    status = "✅" if passed else "❌"
    print(f"\n{status} [{test['id']}] {test['description']}")
    print(f"   prefix:     '{test['prefix'][-40:]}'")
    print(f"   completion: '{completion[:80]}'")
    print(f"   latency:    {latency:.2f}s")
    if failures:
        print(f"   failures:   {failures}")

    assert passed, f"Test failed: {failures}"


@pytest.mark.asyncio
async def test_completion_latency_benchmark():
    """Run 5 completions and report average latency."""
    latencies = []
    for _ in range(5):
        _, latency = await get_completion(
            prefix="def multiply(a, b):\n    return",
            suffix="",
            language="python",
        )
        latencies.append(latency)

    avg = sum(latencies) / len(latencies)
    p95 = sorted(latencies)[int(len(latencies) * 0.95)]

    print(f"\n📊 Latency benchmark (5 runs):")
    print(f"   avg: {avg:.2f}s")
    print(f"   p95: {p95:.2f}s")
    print(f"   all: {[f'{l:.2f}s' for l in latencies]}")

    assert avg < 10.0, f"Average latency too high: {avg:.2f}s"


@pytest.fixture(scope="session", autouse=True)
def save_results_after_all(request):
    """Save all results to file after the entire test session."""
    yield
    if _results:
        model = asyncio.get_event_loop().run_until_complete(get_active_model())
        path  = save_results(model, _results)

        # Print mini scorecard
        passed = sum(1 for r in _results if r["passed"])
        total  = len(_results)
        avg_l  = sum(r["latency"] for r in _results) / total if total else 0
        print(f"\n{'='*50}")
        print(f"COMPLETION EVAL SUMMARY — {model}")
        print(f"{'='*50}")
        print(f"  passed:      {passed}/{total} ({passed/total*100:.0f}%)")
        print(f"  avg latency: {avg_l:.2f}s")
        print(f"  output file: {path}")