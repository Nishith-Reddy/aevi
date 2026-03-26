"""
aevi Evaluation Runner

Runs all evaluation suites and prints a summary scorecard.

Usage:
    uv run python eval/run_eval.py              # run all
    uv run python eval/run_eval.py --chat       # chat only
    uv run python eval/run_eval.py --agent      # agent only
    uv run python eval/run_eval.py --completion # completion only
"""
import subprocess
import sys
import time
import argparse
import httpx
import os
import json


def check_backend():
    """Make sure the backend is running before running evals."""
    try:
        resp = httpx.get("http://127.0.0.1:8765/api/models", timeout=3.0)
        data = resp.json()
        print(f"✅ Backend running — model: {data.get('active')}")
        return True
    except Exception:
        print("❌ Backend is not running!")
        print("   Start it with: cd backend && uv run python main.py")
        return False


def run_suite(name: str, test_file: str) -> dict:
    """Run a pytest test file and return results."""
    print(f"\n{'='*50}")
    print(f"Running: {name}")
    print(f"{'='*50}")
    
    report_path = f"/tmp/{name.replace(' ', '_').lower()}_report.json"

    start = time.time()
    result = subprocess.run(
    [
    "uv", "run", "pytest", test_file,
    "-v",
    "--json-report",
    f"--json-report-file={report_path}",
    "--json-report-verbosity=1"
    ],
    cwd=sys.path[0] + "/..",
    )
    duration = time.time() - start

    report = {}
    
    #load report
    if os.path.exists(report_path):
        with open(report_path) as f:
            report = json.load(f)

    tests = report.get("tests", [])
    summary = report.get("summary", {})

    return {
        "name": name,
        "passed": result.returncode == 0,
        "duration": duration,
        "total_tests": summary.get("total", 0),
        "passed_tests": summary.get("passed", 0),
        "failed_tests": summary.get("failed", 0),
        "tests": tests,  # full per-test breakdown
    }


def print_scorecard(results: list[dict]):
    print(f"\n{'='*50}")
    print("aevi EVAL SCORECARD")
    print(f"{'='*50}")

    total_suites = len(results)
    passed_suites = sum(1 for r in results if r["passed"])

    total_tests = sum(r.get("total_tests", 0) for r in results)
    passed_tests = sum(r.get("passed_tests", 0) for r in results)

    for r in results:
        status = "✅ PASS" if r["passed"] else "❌ FAIL"
        print(
            f"  {status}  {r['name']:<25} "
            f"{r['passed_tests']}/{r['total_tests']} tests "
            f"({r['duration']:.1f}s)"
        )
        for test in r.get("tests", []):
            if test["outcome"] == "failed":
                print(f"     ❌ {test['nodeid']}")

    print(f"{'─'*50}")
    print(f"  Suites: {passed_suites}/{total_suites}")
    print(f"  Tests:  {passed_tests}/{total_tests} ({(passed_tests/total_tests*100 if total_tests else 0):.0f}%)")

    if passed_tests == total_tests:
        print("\n🎉 All tests passed! aevi is solid.")
    elif passed_tests / total_tests >= 0.66:
        print("\n⚠️  Some issues found.")
    else:
        print("\n🔴 Needs improvement.")


def main():
    parser = argparse.ArgumentParser(description="Run aevi evaluations")
    parser.add_argument("--chat",       action="store_true", help="Run chat eval only")
    parser.add_argument("--agent",      action="store_true", help="Run agent eval only")
    parser.add_argument("--completion", action="store_true", help="Run completion eval only")
    args = parser.parse_args()

    if not check_backend():
        sys.exit(1)

    run_all = not any([args.chat, args.agent, args.completion])

    suites = []
    if args.chat or run_all:
        suites.append(("Chat Quality",       "eval/test_chat.py"))
    if args.agent or run_all:
        suites.append(("Agent Correctness",  "eval/test_agent.py"))
    if args.completion or run_all:
        suites.append(("Completion Quality", "eval/test_completion.py"))

    results = [run_suite(name, path) for name, path in suites]
    print_scorecard(results)


if __name__ == "__main__":
    main()