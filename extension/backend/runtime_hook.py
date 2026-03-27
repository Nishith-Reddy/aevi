import os
import sys

if getattr(sys, "frozen", False):
    bundle_dir = sys._MEIPASS

    # Fix SSL certificates
    cert_path = os.path.join(bundle_dir, "certifi", "cacert.pem")
    if os.path.exists(cert_path):
        os.environ["SSL_CERT_FILE"]      = cert_path
        os.environ["REQUESTS_CA_BUNDLE"] = cert_path
        os.environ["CURL_CA_BUNDLE"]     = cert_path

    # Fix tiktoken encoding files — must be on TIKTOKEN_CACHE_DIR
    tiktoken_cache = os.path.join(bundle_dir, "tiktoken_ext")
    if os.path.exists(tiktoken_cache):
        os.environ["TIKTOKEN_CACHE_DIR"] = tiktoken_cache

    # Also point tiktoken to the bundled registry
    tiktoken_dir = os.path.join(bundle_dir, "tiktoken")
    if os.path.exists(tiktoken_dir):
        os.environ["TIKTOKEN_CACHE_DIR"] = tiktoken_dir

    # HuggingFace persistent cache
    hf_cache = os.path.join(os.path.expanduser("~"), ".cache", "aevi", "huggingface")
    os.makedirs(hf_cache, exist_ok=True)
    os.environ["HF_HOME"]                    = hf_cache
    os.environ["TRANSFORMERS_CACHE"]         = hf_cache
    os.environ["SENTENCE_TRANSFORMERS_HOME"] = hf_cache