import json
import os
import sys
import httpx
import pytest
import time
from datetime import datetime
from deepeval import evaluate
from deepeval.metrics import AnswerRelevancyMetric, GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams
from deepeval.models import OllamaModel

from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
from rich.console import Console

# 1. GLOBAL CONFIG & TIMEOUT OVERRIDE
os.environ["DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE"] = "300"
BACKEND_URL  = "http://127.0.0.1:8765"
DATASETS_DIR = os.path.join(os.path.dirname(__file__), "datasets")
PROJECT_ROOT = "/Users/nishithreddy/projects/telivi"

# 2. EVALUATOR MODEL
local_model = OllamaModel(
    model="phi4-mini:latest",
    base_url="http://localhost:11434",
    temperature=0
)

# 3. GLOBAL STATE FOR JSON REPORT
TEST_RESULTS = []
BACKEND_MODEL_NAME = "unknown_model"

@pytest.fixture(scope="session", autouse=True)
def save_chat_report():
    """Pytest fixture to aggregate results and save the JSON report at the end."""
    global BACKEND_MODEL_NAME
    # Fetch the active model from the backend for the filename
    try:
        resp = httpx.get(f"{BACKEND_URL}/api/models", timeout=3.0)
        BACKEND_MODEL_NAME = resp.json().get("active", "unknown_model")
    except Exception:
        pass

    yield  # Let all tests run

    # Post-test aggregation
    total = len(TEST_RESULTS)
    if total == 0:
        return

    passed = sum(1 for r in TEST_RESULTS if r["passed"])
    avg_lat = sum(r["latency"] for r in TEST_RESULTS) / total
    
    # Calculate avg scores, ignoring None
    rel_scores = [r["answer_relevancy"] for r in TEST_RESULTS if r["answer_relevancy"] is not None]
    avg_rel = sum(rel_scores) / len(rel_scores) if rel_scores else 0.0
    
    fai_scores = [r["faithfulness"] for r in TEST_RESULTS if r["faithfulness"] is not None]
    avg_fai = sum(fai_scores) / len(fai_scores) if fai_scores else 0.0

    safe_model_name = BACKEND_MODEL_NAME.replace("/", "_").replace(":", "_")
    filename = f"chat_{safe_model_name}.json"

    report = {
        "model": BACKEND_MODEL_NAME,
        "timestamp": datetime.now().isoformat(),
        "total": total,
        "passed": passed,
        "avg_latency": round(avg_lat, 2),
        "avg_answer_relevancy": round(avg_rel, 2),
        "avg_faithfulness": round(avg_fai, 2),
        "results": TEST_RESULTS
    }

    # Ensure the 'outputs' directory exists in the project root
    OUTPUTS_DIR  = os.path.join(os.path.dirname(__file__), "outputs")
    os.makedirs(OUTPUTS_DIR, exist_ok=True)

    # Save it in the outputs folder
    filepath = os.path.join(OUTPUTS_DIR, filename)
    with open(filepath, "w") as f:
        json.dump(report, f, indent=2)
    
    print(f"\n📊 Detailed Evaluation Report saved to: {filepath}")

# 4. HELPER FUNCTIONS
def load_test_cases():
    """Load the test cases from the JSON file."""
    path = os.path.join(DATASETS_DIR, "chat_tests.json")
    with open(path) as f:
        return json.load(f)

def load_file_content(relative_path: str) -> str:
    """Load a file from the project for use as context."""
    full_path = os.path.join(PROJECT_ROOT, relative_path)
    try:
        with open(full_path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return f"[File not found: {full_path}]"

async def ask_telivi(question: str, file_path: str, file_content: str) -> str:
    """Send a question to the telivi chat endpoint."""
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{BACKEND_URL}/api/chat",
            json={
                "messages": [{"role": "user", "content": question}],
                "current_file": file_path,
                "current_code": file_content,
                "language": "python",
            }
        )
        return resp.text

# 5. THE TEST FUNCTION
@pytest.mark.asyncio
@pytest.mark.parametrize("test_case", load_test_cases(), ids=[t["id"] for t in load_test_cases()])
async def test_chat_quality(test_case: dict):
    file_content = load_file_content(test_case["file"])
    short_context = file_content[:5000]
    expected_output = test_case.get("expected_output")
    
    custom_console = Console(stderr=True)
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        TimeElapsedColumn(),
        console=custom_console,
        transient=True,
    ) as progress:
        
        # --- STAGE 1: BACKEND CALL ---
        task_id = progress.add_task(f"[cyan]🤖 {test_case['id']} - Waiting for Telivi Backend...", total=None)
        
        start_time = time.time()
        actual_output = await ask_telivi(
            question=test_case["question"],
            file_path=test_case["file"],
            file_content=file_content
        )
        latency = time.time() - start_time
        
        # --- STAGE 2: DEEPEVAL JUDGING ---
        progress.update(task_id, description=f"[yellow]⚖️ {test_case['id']} - DeepEval Grading (Backend latency: {latency:.1f}s)...")

        case = LLMTestCase(
            input=test_case["question"],
            actual_output=actual_output,
            expected_output=expected_output,
            retrieval_context=[short_context],
            context=[short_context]
        )

        copilot_faithfulness = GEval(
            name="Copilot Faithfulness",
            criteria="""
            Determine if the actual output is factually consistent with the retrieval context. 
            CRITICAL INSTRUCTION: The model is ALLOWED and ENCOURAGED to generate hypothetical 
            examples, sample inputs/outputs, tables, and explanatory analogies to help explain the code. 
            Do NOT penalize these illustrative additions as hallucinations or inconsistencies. 
            Reward them if they accurately reflect the underlying logic of the source code. 
            Only penalize the output if it explicitly contradicts the provided context or explains 
            a fundamentally incorrect mechanism.
            """,
            evaluation_params=[
                LLMTestCaseParams.INPUT, 
                LLMTestCaseParams.ACTUAL_OUTPUT, 
                LLMTestCaseParams.RETRIEVAL_CONTEXT
            ],
            model=local_model,
            threshold=0.6,
            async_mode=False
        )

        metrics = [
            AnswerRelevancyMetric(threshold=0.6, model=local_model, async_mode=False),
            copilot_faithfulness
        ]

        # evaluate() returns an EvaluationResult object which contains the final scores
        eval_output = evaluate([case], metrics)
        
        # Extract the result for our specific test case
        if isinstance(eval_output, list):
            case_result = eval_output[0]
        else:
            case_result = eval_output.test_results[0]
            
        progress.update(task_id, description=f"[green]✅ {test_case['id']} - Complete!")
    
    failed_metrics = []
    rel_score = None
    fai_score = None

    # Iterate through the ACTUAL results returned by DeepEval
    for metric_data in case_result.metrics_data:
        metric_name = metric_data.name
        score = metric_data.score
        
        if "Answer Relevancy" in metric_name:
            rel_score = score
        elif "Copilot Faithfulness" in metric_name:
            fai_score = score
        
        error = getattr(metric_data, "error", None)
        if error:
            failed_metrics.append(f"⚠️ {metric_name} ERROR: {error}")
        elif score is not None and score < metric_data.threshold:
            reason = getattr(metric_data, 'reason', 'N/A')
            failed_metrics.append(f"❌ {metric_name} failed with score {score:.2f} - Reason: {reason}")

    keywords_found = [kw for kw in test_case["context_keywords"] if kw.lower() in actual_output.lower()]
    if len(test_case["context_keywords"]) > 0:
        coverage = len(keywords_found) / len(test_case["context_keywords"])
        if coverage < 0.5:
            failed_metrics.append(f"❌ Keyword coverage failed: Expected 50%, got {coverage*100:.0f}%")

    # Add to global JSON accumulator with actual and expected outputs
    TEST_RESULTS.append({
        "id": test_case["id"],
        "description": test_case["question"],
        "expected_output": expected_output,
        "actual_output": actual_output,
        "latency": round(latency, 2),
        "answer_relevancy": rel_score,
        "faithfulness": fai_score,
        "passed": len(failed_metrics) == 0,
        "failures": failed_metrics
    })

    if failed_metrics:
        pytest.fail("\n" + "\n\n".join(failed_metrics))