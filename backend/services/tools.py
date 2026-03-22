import os
import subprocess

# Safety limits
MAX_FILE_BYTES   = 100_000   # 100KB max file read
MAX_OUTPUT_BYTES = 3_000     # 3KB max command output

# Commands that could cause damage — always blocked
BLOCKED_COMMANDS = {
    "rm", "mv", "cp", "curl", "wget",
    "sudo", "chmod", "chown", "kill",
    "dd", "mkfs", "shutdown", "reboot"
}


async def read_file(path: str) -> str:
    """Read a file and return its contents as a string."""
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            return (
                f"[Error] File too large ({size} bytes). "
                f"Max allowed is {MAX_FILE_BYTES} bytes."
            )
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except FileNotFoundError:
        return f"[Error] File not found: {path}"
    except Exception as e:
        return f"[Error reading file] {e}"


async def write_file(path: str, content: str) -> str:
    """Write content to a file, creating directories if needed."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"[OK] Written to {path}"
    except Exception as e:
        return f"[Error writing file] {e}"


async def list_dir(path: str) -> str:
    """List all files and folders in a directory."""
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
    """
    Run a read-only shell command safely.
    Blocked commands (rm, mv, sudo, etc.) are always rejected.
    """
    # Check for blocked commands
    first_word = command.strip().split()[0] if command.strip() else ""
    if first_word in BLOCKED_COMMANDS:
        return (
            f"[Blocked] '{first_word}' is not allowed for safety reasons. "
            f"Telivi only runs read-only commands."
        )

    # Also block output redirection
    if ">" in command or ">>" in command:
        return "[Blocked] Output redirection is not allowed."

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=10
        )
        stdout = result.stdout[:MAX_OUTPUT_BYTES]
        stderr = result.stderr[:500]
        output = stdout
        if stderr:
            output += f"\n[stderr] {stderr}"
        return output or "[No output]"
    except subprocess.TimeoutExpired:
        return "[Error] Command timed out after 10 seconds."
    except Exception as e:
        return f"[Error running command] {e}"