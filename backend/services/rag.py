import os
import lancedb
from sentence_transformers import SentenceTransformer
from config import settings

# Load embedding model once at startup
_embed_model = SentenceTransformer("all-MiniLM-L6-v2")

# Cache open DB connections
_dbs: dict[str, lancedb.DBConnection] = {}

# Only index these file types
SUPPORTED_EXTENSIONS = {
    ".py", ".ts", ".js", ".tsx", ".jsx",
    ".go", ".rs", ".java", ".cpp", ".c",
    ".md", ".txt", ".yaml", ".toml"
}

# Folders to skip when indexing
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__",
    ".venv", "venv", "dist", "build", ".next",
    "out", "coverage", ".turbo"
}

# Files to skip
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "uv.lock", "poetry.lock", "Cargo.lock"
}


def _get_db(workspace: str) -> lancedb.DBConnection:
    """Get or create a LanceDB connection for a workspace."""
    if workspace not in _dbs:
        db_path = os.path.join(
            settings.rag_db_path,
            workspace.replace("/", "_").strip("_")
        )
        _dbs[workspace] = lancedb.connect(db_path)
    return _dbs[workspace]


def _chunk_text(text: str, chunk_size: int = 100) -> list[str]:
    """
    Split file content into overlapping chunks by word count.
    Overlap helps the model get context across chunk boundaries.
    """
    lines = text.splitlines(keepends=True)
    chunks, buf, count = [], [], 0

    for line in lines:
        buf.append(line)
        count += len(line.split())
        if count >= chunk_size:
            chunks.append("".join(buf))
            # Keep last 2 lines for overlap
            buf = buf[-2:]
            count = sum(len(l.split()) for l in buf)

    if buf:
        chunks.append("".join(buf))

    return chunks


async def index_workspace(workspace_path: str) -> int:
    """
    Walk the workspace, chunk all code files, embed them,
    and store in LanceDB. Returns number of chunks indexed.
    """
    db = _get_db(workspace_path)
    records = []

    for root, dirs, files in os.walk(workspace_path):
        # Remove skip dirs in-place so os.walk doesn't descend into them
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        for fname in files:
            # Skip lock files and other noise
            if fname in SKIP_FILES:
                continue
            ext = os.path.splitext(fname)[1]
            if ext not in SUPPORTED_EXTENSIONS:
                continue

            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue

            if not content.strip():
                continue

            for i, chunk in enumerate(_chunk_text(content, settings.rag_chunk_size)):
                vector = _embed_model.encode(chunk).tolist()
                records.append({
                    "path":     fpath,
                    "chunk_id": i,
                    "text":     chunk,
                    "vector":   vector,
                })

    if records:
        tbl_name = "code_chunks"
        if tbl_name in db.table_names():
            db.drop_table(tbl_name)
        db.create_table(tbl_name, records)

    return len(records)


async def retrieve_context(query: str, workspace_path: str) -> str:
    """
    Embed the query, search LanceDB for the most similar
    code chunks, and return them as a single string to
    inject into the LLM prompt.
    """
    db = _get_db(workspace_path)

    if "code_chunks" not in db.table_names():
        return ""

    query_vector = _embed_model.encode(query).tolist()
    tbl = db.open_table("code_chunks")
    results = tbl.search(query_vector).limit(settings.rag_top_k).to_list()

    if not results:
        return ""

    parts = []
    for r in results:
        parts.append(f"# {r['path']}\n{r['text']}")

    return "\n\n---\n\n".join(parts)

async def remove_file_from_index(workspace_path: str, file_path: str) -> int:
    """Remove all chunks belonging to a specific file from the index."""
    db = _get_db(workspace_path)
    if "code_chunks" not in db.table_names():
        return 0
    tbl    = db.open_table("code_chunks")
    before = tbl.count_rows()
    tbl.delete(f"path = '{file_path}'")
    after  = tbl.count_rows()
    return before - after