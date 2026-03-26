import os
import subprocess
import re as _re

MAX_FILE_BYTES   = 100_000
MAX_OUTPUT_BYTES = 3_000

BLOCKED_COMMANDS = {
    "rm", "mv", "cp", "curl", "wget",
    "sudo", "chmod", "chown", "kill",
    "dd", "mkfs", "shutdown", "reboot"
}


async def read_file(path: str, start_line: int = None, end_line: int = None) -> str:
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            return f"[Error] File too large ({size} bytes). Max allowed is {MAX_FILE_BYTES} bytes."
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            if start_line is not None and end_line is not None:
                lines     = f.readlines()
                start_idx = max(0, start_line - 1)
                end_idx   = min(len(lines), end_line)
                return "".join(lines[start_idx:end_idx])
            return f.read()
    except FileNotFoundError:
        return f"[Error] File not found: {path}"
    except Exception as e:
        return f"[Error reading file] {e}"


async def write_file(path: str, content: str) -> str:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"[OK] Written to {path}"
    except Exception as e:
        return f"[Error writing file] {e}"


async def edit_file(path: str, search_text: str, replace_text: str) -> str:
    original = await read_file(path)
    if original.startswith("[Error"):
        return original
    if search_text not in original:
        return (
            "[Error] The search_text was not found in the file. "
            "You must match the text exactly, including whitespace. Please try again."
        )
    updated = original.replace(search_text, replace_text, 1)
    return await write_file(path, updated)


async def edit_lines(path: str, start_line: int, end_line: int, new_content: str) -> str:
    original = await read_file(path)
    if original.startswith("[Error"):
        return original
    lines = original.splitlines(keepends=True)
    total = len(lines)
    if start_line < 1 or end_line > total or start_line > end_line:
        return f"[Error] Line range {start_line}-{end_line} is out of bounds (file has {total} lines)."
    replacement   = new_content if (not new_content or new_content.endswith("\n")) else new_content + "\n"
    updated_lines = lines[:start_line - 1] + ([replacement] if replacement else []) + lines[end_line:]
    return await write_file(path, "".join(updated_lines))


async def insert_lines(path: str, after_line: int, content: str) -> str:
    """Insert content after a specific line number without replacing anything.
    Use after_line=0 to insert at the very beginning of the file."""
    original = await read_file(path)
    if original.startswith("[Error"):
        return original
    lines = original.splitlines(keepends=True)
    total = len(lines)
    if after_line < 0 or after_line > total:
        return f"[Error] after_line {after_line} is out of bounds (file has {total} lines)."
    insertion = content if content.endswith("\n") else content + "\n"
    updated   = lines[:after_line] + [insertion] + lines[after_line:]
    return await write_file(path, "".join(updated))


async def goto_line(path: str, line: int, context: int = 5) -> str:
    result = await read_file(path, start_line=max(1, line - context), end_line=line + context)
    if result.startswith("[Error"):
        return result
    start    = max(1, line - context)
    numbered = [f"{start + i:>6} | {l}" for i, l in enumerate(result.splitlines())]
    return "\n".join(numbered)


async def find_in_file(path: str, pattern: str, context: int = 3) -> str:
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            return f"[Error] File too large ({size} bytes). Max allowed is {MAX_FILE_BYTES} bytes."
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return f"[Error] File not found: {path}"
    except Exception as e:
        return f"[Error reading file] {e}"

    import re
    matches = [i for i, l in enumerate(lines) if re.search(pattern, l)]
    if not matches:
        return f"[No matches] Pattern '{pattern}' not found in {path}."

    results = []
    covered = set()
    for m in matches:
        start = max(0, m - context)
        end   = min(len(lines), m + context + 1)
        if any(i in covered for i in range(start, end)):
            continue
        covered.update(range(start, end))
        block = [f"{start + i + 1:>6} | {l.rstrip()}" for i, l in enumerate(lines[start:end])]
        results.append("\n".join(block))

    return f"\n{'—' * 40}\n".join(results)


async def write_plan(workspace_path: str, task: str, steps: list) -> str:
    import json as _json
    path = os.path.join(workspace_path, ".telivi-plan.json")
    existing_done: dict = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            existing = _json.load(f)
            for s in existing.get("steps", []):
                if s.get("status") == "done":
                    existing_done[s["id"]] = "done"
    except Exception:
        pass
    for step in steps:
        if step.get("id") in existing_done:
            step["status"] = "done"
    plan = {"task": task, "steps": steps}
    try:
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(plan, f, indent=2)
        pending = sum(1 for s in steps if s.get("status") == "pending")
        return f"[OK] Plan written to {path} — {len(steps)} steps total, {pending} pending."
    except Exception as e:
        return f"[Error writing plan] {e}"


async def update_plan_step(workspace_path: str, step_id: int, status: str) -> str:
    import json as _json
    path = os.path.join(workspace_path, ".telivi-plan.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            plan = _json.load(f)
        updated = False
        for step in plan.get("steps", []):
            if step.get("id") == step_id:
                if step.get("status") == "done":
                    return f"[OK] Step {step_id} was already done — no change."
                step["status"] = status
                updated = True
                break
        if not updated:
            return f"[Error] Step {step_id} not found in plan."
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(plan, f, indent=2)
        remaining = [s for s in plan["steps"] if s.get("status") == "pending"]
        return f"[OK] Step {step_id} marked {status}. {len(remaining)} steps remaining."
    except FileNotFoundError:
        return f"[Error] Plan file not found at {path}. Call write_plan first."
    except Exception as e:
        return f"[Error updating plan] {e}"


async def cleanup_plan(workspace_path: str) -> str:
    path = os.path.join(workspace_path, ".telivi-plan.json")
    try:
        os.remove(path)
        return "[OK] Plan file removed."
    except FileNotFoundError:
        return "[OK] No plan file to remove."
    except Exception as e:
        return f"[Error removing plan] {e}"


# --- tree-sitter language map ---
_TS_DECLARATION_TYPES: dict = {
    "python":     ["function_definition", "async_function_definition", "class_definition"],
    "javascript": ["function_declaration", "arrow_function", "class_declaration", "method_definition", "lexical_declaration", "variable_declaration"],
    "typescript": ["function_declaration", "arrow_function", "class_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "lexical_declaration"],
    "tsx":        ["function_declaration", "arrow_function", "class_declaration", "method_definition", "interface_declaration", "lexical_declaration"],
    "jsx":        ["function_declaration", "arrow_function", "class_declaration", "method_definition", "lexical_declaration"],
    "go":         ["function_declaration", "method_declaration", "type_declaration"],
    "rust":       ["function_item", "impl_item", "struct_item", "enum_item", "trait_item", "mod_item"],
    "java":       ["class_declaration", "method_declaration", "interface_declaration", "enum_declaration", "constructor_declaration"],
    "cpp":        ["function_definition", "class_specifier", "struct_specifier", "namespace_definition"],
    "c":          ["function_definition", "struct_specifier"],
    "ruby":       ["method", "singleton_method", "class", "module"],
    "swift":      ["function_declaration", "class_declaration", "struct_declaration", "protocol_declaration", "extension_declaration"],
    "kotlin":     ["function_declaration", "class_declaration", "object_declaration", "interface_declaration"],
    "php":        ["function_definition", "method_declaration", "class_declaration", "interface_declaration"],
}

_EXT_TO_LANG: dict = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".tsx": "tsx", ".jsx": "jsx", ".go": "go", ".rs": "rust",
    ".java": "java", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
    ".c": "c", ".h": "c", ".rb": "ruby", ".swift": "swift",
    ".kt": "kotlin", ".php": "php",
}


def _name_from_node(node, source_bytes: bytes):
    for child in node.children:
        if child.type in ("identifier", "name", "property_identifier",
                          "type_identifier", "field_identifier"):
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="ignore")
    return None


def _outline_with_treesitter(source: str, lang_name: str):
    try:
        from tree_sitter_languages import get_parser  # type: ignore
        parser     = get_parser(lang_name)
        src_b      = source.encode("utf-8")
        tree       = parser.parse(src_b)
        decl_types = set(_TS_DECLARATION_TYPES.get(lang_name, []))
        if not decl_types:
            return None
        results = []

        def walk(node, depth: int = 0):
            if node.type in decl_types:
                name    = _name_from_node(node, src_b)
                line_no = node.start_point[0] + 1
                indent  = "  " * depth
                label   = name if name else f"<{node.type}>"
                results.append((line_no, f"{line_no:>6} | {indent}{node.type}: {label}"))
            for child in node.children:
                walk(child, depth + (1 if node.type in decl_types else 0))

        walk(tree.root_node)
        results.sort(key=lambda x: x[0])
        return [r[1] for r in results]
    except Exception:
        return None


def _outline_with_ast(source: str):
    import ast as _ast
    try:
        tree    = _ast.parse(source)
        results = []
        for node in _ast.walk(tree):
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                kind = ("class" if isinstance(node, _ast.ClassDef)
                        else "async def" if isinstance(node, _ast.AsyncFunctionDef)
                        else "def")
                results.append((node.lineno, f"{node.lineno:>6} | {kind} {node.name}"))
        results.sort(key=lambda x: x[0])
        return [r[1] for r in results]
    except Exception:
        return None


def _outline_with_regex(source: str):
    pattern = _re.compile(
        r'^(?P<indent>\s*)'
        r'(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*'
        r'(?:function\s+|class\s+|const\s+|let\s+|var\s+|def\s+|async\s+def\s+|fn\s+|func\s+|sub\s+|procedure\s+)'
        r'(?P<n>\w+)'
    )
    results = []
    for i, line in enumerate(source.splitlines(), start=1):
        m = pattern.match(line)
        if m:
            depth  = len(m.group("indent")) // 2
            prefix = "  " * depth
            results.append(f"{i:>6} | {prefix}{line.strip()}")
    return results


async def file_outline(path: str) -> str:
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            return f"[Error] File too large ({size} bytes). Max allowed is {MAX_FILE_BYTES} bytes."
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            source = f.read()
    except FileNotFoundError:
        return f"[Error] File not found: {path}"
    except Exception as e:
        return f"[Error reading file] {e}"

    total_lines = source.count("\n") + 1
    header      = f"File has {total_lines} lines.\n\n"
    ext         = os.path.splitext(path)[1].lower()
    lang        = _EXT_TO_LANG.get(ext)

    if lang:
        outline = _outline_with_treesitter(source, lang)
        if outline:
            return header + "\n".join(outline)

    if ext == ".py":
        outline = _outline_with_ast(source)
        if outline:
            return header + "\n".join(outline)

    outline = _outline_with_regex(source)
    if outline:
        return header + "\n".join(outline)

    return header + "[No outline] Could not detect structure. Use find_in_file to search directly."


async def list_dir(path: str) -> str:
    try:
        entries = sorted(os.listdir(path))
        if not entries:
            return "[Empty directory]"
        return "\n".join(entries)
    except FileNotFoundError:
        return f"[Error] Directory not found: {path}"
    except Exception as e:
        return f"[Error listing directory] {e}"


async def run_command(command: str) -> str:
    first_word = command.strip().split()[0] if command.strip() else ""
    if first_word in BLOCKED_COMMANDS:
        return (
            f"[Blocked] '{first_word}' is not allowed for safety reasons. "
            f"Telivi only runs read-only commands."
        )
    if ">>" in command or ("> " in command and "2>&1" not in command):
        return "[Blocked] Output redirection to files is not allowed."
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=30
        )
        stdout = result.stdout[:MAX_OUTPUT_BYTES]
        stderr = result.stderr[:500]
        noise_dirs    = [".venv", "node_modules", "__pycache__", ".git"]
        filtered_lines = [
            line for line in stdout.splitlines()
            if not any(nd in line for nd in noise_dirs)
        ]
        output = "\n".join(filtered_lines)
        if stderr:
            output += f"\n[stderr] {stderr}"
        return output or "[No output]"
    except subprocess.TimeoutExpired:
        return "[Error] Command timed out after 30 seconds."
    except Exception as e:
        return f"[Error running command] {e}"